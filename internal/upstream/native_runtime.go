package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
)

const maxProviderResponseBytes = 256 << 20

// nativeRuntime is Relay's provider runtime. It owns credentials, model
// routing and upstream HTTP execution without embedding another API server or
// importing a third-party gateway implementation.
type nativeRuntime struct {
	mu          sync.RWMutex
	options     Options
	settings    Settings
	credentials map[string]*nativeCredential
	modelRoutes map[string][]string
	models      []string
	next        atomic.Uint64
	handler     http.Handler
	oauth       *oauthManager
}

type nativeCredential struct {
	mu      sync.Mutex
	tokenMu sync.Mutex
	Credential
	Provider     string
	BaseURL      string
	APIKey       string
	AccessToken  string
	RefreshToken string
	AccountID    string
	Headers      http.Header
	ProxyURL     string
	Prefix       string
	ModelRoutes  map[string]string
	Status       CredentialStatus
	client       *http.Client
	document     map[string]any
	expiresAt    time.Time
}

// NewRuntime creates the focused Relay runtime for Codex, Kimi, xAI and
// OpenAI-compatible providers.
func NewRuntime(options Options, credentials []Credential) (Runtime, error) {
	r := &nativeRuntime{options: options, credentials: make(map[string]*nativeCredential), modelRoutes: make(map[string][]string)}
	r.settings = Settings{
		RequestRetry:     options.RequestRetry,
		MaxRetryInterval: options.MaxRetryInterval, RoutingStrategy: options.RoutingStrategy,
		ProxyURL: options.ProxyURL, PassthroughHeaders: options.PassthroughHeaders,
		ForceModelPrefix: options.ForceModelPrefix,
	}
	r.oauth = newOAuthManager(options)
	r.handler = http.HandlerFunc(r.serveHTTP)
	if err := r.ReplaceCredentials(context.Background(), credentials); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *nativeRuntime) Handler() http.Handler { return r.handler }

func (r *nativeRuntime) CredentialCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.credentials)
}

func (r *nativeRuntime) Models() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]string(nil), r.models...)
}

func (r *nativeRuntime) ModelProvider(model string) (string, bool) {
	credential, ok := r.selectCredential(model, "")
	if !ok {
		return "", false
	}
	return credential.Provider, true
}

func (r *nativeRuntime) CredentialModels(id string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	credential := r.credentials[strings.TrimSpace(id)]
	if credential == nil {
		return nil
	}
	return append([]string(nil), credential.Models...)
}

func (r *nativeRuntime) CredentialStatus(id string) (CredentialStatus, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	credential := r.credentials[strings.TrimSpace(id)]
	if credential == nil {
		return CredentialStatus{}, false
	}
	credential.mu.Lock()
	defer credential.mu.Unlock()
	return credential.Status, true
}

func (r *nativeRuntime) DiscoverCredentialModels(ctx context.Context, id string) ([]string, string, error) {
	r.mu.RLock()
	credential := r.credentials[strings.TrimSpace(id)]
	r.mu.RUnlock()
	if credential == nil {
		return nil, "", fmt.Errorf("upstream credential %q is not registered", id)
	}
	if credential.Provider != "kimi" {
		models, err := credential.discoverModels(ctx)
		if err == nil && len(models) > 0 {
			r.mu.Lock()
			credential.Models = models
			r.rebuildRoutesLocked()
			r.mu.Unlock()
			return models, "upstream", nil
		}
		if len(credential.Models) == 0 {
			return nil, "", err
		}
		return append([]string(nil), credential.Models...), "configured", err
	}
	return append([]string(nil), credential.Models...), "native", nil
}

func (r *nativeRuntime) ReplaceCredentials(_ context.Context, credentials []Credential) error {
	compiled := make(map[string]*nativeCredential, len(credentials))
	for _, source := range credentials {
		if !source.Enabled {
			continue
		}
		credential, err := compileNativeCredential(source, r.settings.ProxyURL)
		if err != nil {
			return err
		}
		compiled[credential.ID] = credential
	}
	r.mu.Lock()
	r.credentials = compiled
	r.rebuildRoutesLocked()
	r.mu.Unlock()
	return nil
}

func (r *nativeRuntime) ApplySettings(_ context.Context, settings Settings) error {
	if settings.RoutingStrategy != "" && settings.RoutingStrategy != "round-robin" && settings.RoutingStrategy != "fill-first" {
		return fmt.Errorf("unsupported routing strategy %q", settings.RoutingStrategy)
	}
	r.mu.Lock()
	r.settings = settings
	credentials := make([]Credential, 0, len(r.credentials))
	for _, credential := range r.credentials {
		credentials = append(credentials, credential.Credential)
	}
	r.mu.Unlock()
	return r.ReplaceCredentials(context.Background(), credentials)
}

func (r *nativeRuntime) ResolveCredentialModel(id, model string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	credential := r.credentials[strings.TrimSpace(id)]
	if credential == nil {
		return model
	}
	if target := credential.ModelRoutes[strings.ToLower(strings.TrimSpace(model))]; target != "" {
		return target
	}
	return model
}

func (r *nativeRuntime) StartOAuth(ctx context.Context, provider, sessionID string) (OAuthStartResult, error) {
	return r.oauth.start(ctx, provider, sessionID)
}
func (r *nativeRuntime) OAuthStatus(ctx context.Context, state string) (OAuthStatusResult, error) {
	return r.oauth.status(ctx, state)
}
func (r *nativeRuntime) SubmitOAuthCallback(ctx context.Context, provider, state, redirectURL string) error {
	return r.oauth.submitCallback(ctx, provider, state, redirectURL)
}
func (r *nativeRuntime) CancelOAuth(_ context.Context, state string) error {
	r.oauth.cancel(state)
	return nil
}
func (r *nativeRuntime) Close(context.Context) error {
	r.oauth.close()
	return nil
}

func (r *nativeRuntime) rebuildRoutesLocked() {
	r.modelRoutes = make(map[string][]string)
	modelSet := make(map[string]string)
	ids := make([]string, 0, len(r.credentials))
	for id := range r.credentials {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		credential := r.credentials[id]
		for _, model := range credential.Models {
			public := strings.TrimSpace(model)
			if public == "" {
				continue
			}
			if prefix := strings.Trim(strings.TrimSpace(credential.Prefix), "/"); prefix != "" && r.settings.ForceModelPrefix {
				public = prefix + "/" + public
			}
			key := strings.ToLower(public)
			r.modelRoutes[key] = append(r.modelRoutes[key], id)
			modelSet[key] = public
		}
	}
	r.models = make([]string, 0, len(modelSet))
	for _, model := range modelSet {
		r.models = append(r.models, model)
	}
	sort.Slice(r.models, func(i, j int) bool { return strings.ToLower(r.models[i]) < strings.ToLower(r.models[j]) })
}

func (r *nativeRuntime) selectCredential(model, pinnedID string) (*nativeCredential, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if pinnedID != "" {
		credential := r.credentials[pinnedID]
		return credential, credential != nil
	}
	ids := r.modelRoutes[strings.ToLower(strings.TrimSpace(model))]
	if len(ids) == 0 {
		return nil, false
	}
	index := 0
	if r.settings.RoutingStrategy != "fill-first" {
		index = int(r.next.Add(1)-1) % len(ids)
	}
	credential := r.credentials[ids[index]]
	return credential, credential != nil
}

func compileNativeCredential(source Credential, globalProxy string) (*nativeCredential, error) {
	if strings.TrimSpace(source.ID) == "" {
		return nil, errors.New("upstream credential requires an ID")
	}
	var document map[string]any
	if err := json.Unmarshal(source.Document, &document); err != nil {
		return nil, fmt.Errorf("decode upstream credential %q: %w", source.ID, err)
	}
	provider := canonicalProvider(source.Provider)
	if provider == "" {
		return nil, fmt.Errorf("unsupported upstream provider %q", source.Provider)
	}
	if rawType := firstString(document, "type"); rawType != "" {
		documentProvider := canonicalProvider(rawType)
		compatibleOpenAI := (provider == "openai" || provider == "openai-compatibility") && (documentProvider == "openai" || documentProvider == "openai-compatibility")
		if documentProvider == "" || (documentProvider != provider && !compatibleOpenAI) {
			return nil, fmt.Errorf("upstream credential %q type %q does not match provider %q", source.ID, rawType, source.Provider)
		}
	}
	credential := &nativeCredential{
		Credential: source, Provider: provider, APIKey: firstString(document, "api_key"),
		AccessToken: firstString(document, "access_token", "token"), RefreshToken: firstString(document, "refresh_token"),
		AccountID: firstString(document, "account_id", "chatgpt_account_id"), Headers: make(http.Header),
		ProxyURL: firstString(document, "proxy_url"), Prefix: firstString(document, "prefix"), ModelRoutes: make(map[string]string),
		Status:   CredentialStatus{Status: "active", PlanType: firstString(document, "plan_type")},
		document: document,
	}
	credential.BaseURL = strings.TrimRight(firstString(document, "base_url"), "/")
	credential.expiresAt = parseCredentialTime(firstString(document, "expired", "expires_at", "expire"))
	if credential.BaseURL == "" {
		credential.BaseURL = defaultBaseURL(provider)
	}
	if credential.ProxyURL == "" {
		credential.ProxyURL = globalProxy
	}
	if rawHeaders, ok := document["headers"].(map[string]any); ok {
		for name, value := range rawHeaders {
			if text, ok := value.(string); ok && validHeader(name, text) {
				credential.Headers.Set(name, text)
			}
		}
	}
	if routes, ok := document["model_routes"].([]any); ok {
		for _, value := range routes {
			item, _ := value.(map[string]any)
			public, upstream := firstString(item, "public"), firstString(item, "upstream")
			if public != "" && upstream != "" {
				credential.ModelRoutes[strings.ToLower(public)] = upstream
			}
		}
	}
	credential.Models = normalizedModelList(source.Models)
	if len(credential.Models) == 0 {
		credential.Models = defaultModels(provider)
	}
	client, err := providerHTTPClient(credential.ProxyURL)
	if err != nil {
		return nil, fmt.Errorf("credential %q proxy: %w", source.ID, err)
	}
	credential.client = client
	return credential, nil
}

func canonicalProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "codex":
		return "codex"
	case "kimi":
		return "kimi"
	case "xai", "x.ai", "grok":
		return "xai"
	case "openai":
		return "openai"
	case "openai-compatible", "openai-compatibility", "aliyun-bailian", "bailian":
		return "openai-compatibility"
	default:
		return ""
	}
}

func defaultBaseURL(provider string) string {
	switch provider {
	case "codex":
		return "https://chatgpt.com/backend-api/codex"
	case "kimi":
		return "https://api.kimi.com/coding/v1"
	case "xai":
		return "https://api.x.ai/v1"
	default:
		return "https://api.openai.com/v1"
	}
}

func defaultModels(provider string) []string {
	switch provider {
	case "codex":
		return []string{"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2-codex"}
	case "kimi":
		return []string{"kimi-for-coding", "kimi-k2.5", "kimi-k2-thinking"}
	case "xai":
		return []string{"grok-4.6", "grok-4.5", "grok-code-fast-1"}
	default:
		return nil
	}
}

func normalizedModelList(models []string) []string {
	set := make(map[string]string)
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model != "" {
			set[strings.ToLower(model)] = model
		}
	}
	result := make([]string, 0, len(set))
	for _, model := range set {
		result = append(result, model)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func validHeader(name, value string) bool {
	return strings.TrimSpace(name) != "" && !strings.ContainsAny(name, "\r\n:") && !strings.ContainsAny(value, "\r\n")
}

func providerHTTPClient(proxyURL string) (*http.Client, error) {
	return egress.OutboundHTTPClient(proxyURL, 0)
}

func (c *nativeCredential) discoverModels(ctx context.Context) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.BaseURL, "/")+"/models", nil)
	if err != nil {
		return nil, err
	}
	c.authorize(request.Header)
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxProviderResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("model discovery returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return nil, errors.New("model discovery returned invalid JSON")
	}
	var models []string
	for _, key := range []string{"data", "models"} {
		items, _ := root[key].([]any)
		for _, value := range items {
			item, _ := value.(map[string]any)
			model := firstString(item, "id", "name", "model", "slug")
			model = strings.TrimPrefix(model, "models/")
			if model != "" {
				models = append(models, model)
			}
		}
	}
	return normalizedModelList(models), nil
}

func (c *nativeCredential) authorize(header http.Header) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	for name, values := range c.Headers {
		for _, value := range values {
			header.Add(name, value)
		}
	}
	token := c.APIKey
	if token == "" {
		token = c.AccessToken
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	if c.Provider == "codex" {
		if header.Get("OpenAI-Beta") == "" {
			header.Set("OpenAI-Beta", "responses=experimental")
		}
		if c.AccountID != "" {
			header.Set("ChatGPT-Account-ID", c.AccountID)
		}
	} else if c.Provider == "kimi" {
		deviceID := firstString(c.document, "device_id")
		if deviceID == "" {
			deviceID = c.ID
		}
		for name, values := range kimiOAuthHeaders(deviceID) {
			if header.Get(name) == "" {
				header[name] = append([]string(nil), values...)
			}
		}
		if header.Get("User-Agent") == "" {
			header.Set("User-Agent", "RelayAPI/native")
		}
	}
}

func (r *nativeRuntime) serveHTTP(w http.ResponseWriter, request *http.Request) {
	if key := strings.TrimSpace(r.options.APIKey); key != "" && request.Header.Get("Authorization") != "Bearer "+key {
		writeRuntimeError(w, http.StatusUnauthorized, "invalid_runtime_key", "native runtime authentication failed")
		return
	}
	if request.Method == http.MethodGet && strings.TrimRight(request.URL.Path, "/") == "/v1/models" {
		r.serveModels(w, request)
		return
	}
	if isRuntimeWebSocket(request) {
		r.serveWebSocket(w, request)
		return
	}
	r.serveInference(w, request)
}

func (r *nativeRuntime) serveModels(w http.ResponseWriter, request *http.Request) {
	models := r.Models()
	w.Header().Set("Content-Type", "application/json")
	if _, codex := request.URL.Query()["client_version"]; codex {
		items := make([]map[string]any, 0, len(models))
		for _, model := range models {
			items = append(items, map[string]any{
				"slug": model, "display_name": model, "description": "RelayAPI upstream model", "visibility": "list",
				"context_window": 262144, "max_output_tokens": 32768,
				"apply_patch_tool_type": "freeform", "web_search_tool_type": "text_and_image", "multi_agent_version": "v2",
				"supports_parallel_tool_calls": true, "supports_image_detail_original": true, "supports_search_tool": true,
				"support_verbosity": true, "supports_reasoning_summary_parameter": true, "include_skills_usage_instructions": true,
				"include_plugin_usage_instructions": true, "include_apps_usage_instructions": true, "prefer_websockets": true,
				"input_modalities": []any{"text", "image"},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"models": items})
		return
	}
	items := make([]map[string]any, 0, len(models))
	for _, model := range models {
		provider, _ := r.ModelProvider(model)
		items = append(items, map[string]any{"id": model, "object": "model", "owned_by": provider})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": items})
}

func (r *nativeRuntime) serveInference(w http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<30))
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", "unable to read request")
		return
	}
	model := jsonString(body, "model")
	pinned := strings.TrimSpace(request.Header.Get("X-Relay-Upstream-Credential-ID"))
	credential, ok := r.selectCredential(model, strings.TrimSpace(pinned))
	if !ok {
		writeRuntimeError(w, http.StatusServiceUnavailable, "model_account_unavailable", "no upstream credential can serve this model")
		return
	}
	upstreamModel := credential.ModelRoutes[strings.ToLower(model)]
	if upstreamModel == "" {
		upstreamModel = model
	}
	body = rewriteJSONModel(body, upstreamModel)
	requestPath := canonicalInferencePath(request.URL.Path)
	responseMode := "passthrough"
	var toolRestorer *toolResponseRestorer
	if credential.Provider == "kimi" && isResponsesPath(requestPath) {
		body, err = responsesToChatRequest(body)
		requestPath = "/chat/completions"
		responseMode = "chat-to-responses"
	} else if credential.Provider == "codex" && isChatPath(requestPath) {
		body, err = chatToResponsesRequest(body)
		requestPath = "/responses"
		responseMode = "responses-to-chat"
	}
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if credential.Provider == "xai" {
		body, toolRestorer = lowerCodexTools(body)
	}
	target := credential.upstreamURL(requestPath)
	response, err := r.doProviderRequest(request, credential, target, body)
	if err != nil {
		credential.record(false, err.Error())
		writeRuntimeError(w, http.StatusBadGateway, "upstream_connection_failed", err.Error())
		return
	}
	defer response.Body.Close()
	credential.record(response.StatusCode < 400, "")
	r.mu.RLock()
	passthroughHeaders := r.settings.PassthroughHeaders
	r.mu.RUnlock()
	copyResponseHeaders(w.Header(), response.Header, passthroughHeaders)
	w.WriteHeader(response.StatusCode)
	if response.StatusCode >= 400 || (responseMode == "passthrough" && toolRestorer == nil) {
		_, _ = io.Copy(w, response.Body)
		return
	}
	if jsonBool(body, "stream") {
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if toolRestorer != nil && responseMode == "passthrough" {
			_ = restoreToolStream(w, response.Body, toolRestorer)
		} else {
			_ = translateStream(w, response.Body, responseMode, model)
		}
		return
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxProviderResponseBytes))
	if readErr != nil {
		return
	}
	if toolRestorer != nil {
		payload = toolRestorer.restore(payload)
	} else if responseMode == "chat-to-responses" {
		payload = chatToResponsesResponse(payload, model)
	} else {
		payload = responsesToChatResponse(payload, model)
	}
	_, _ = w.Write(payload)
}

func (r *nativeRuntime) doProviderRequest(source *http.Request, credential *nativeCredential, target string, body []byte) (*http.Response, error) {
	r.mu.RLock()
	requestRetry, maxRetryInterval := r.settings.RequestRetry, r.settings.MaxRetryInterval
	r.mu.RUnlock()
	attempts := requestRetry + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	refreshed := false
	for attempt := 0; attempt < attempts; attempt++ {
		if !refreshed && credential.tokenNeedsRefresh() {
			if refreshErr := r.refreshCredential(source.Context(), credential); refreshErr == nil {
				refreshed = true
			}
		}
		request, err := http.NewRequestWithContext(source.Context(), source.Method, target, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		copyProviderHeaders(request.Header, source.Header)
		credential.authorize(request.Header)
		response, err := credential.client.Do(request)
		if err == nil && response.StatusCode == http.StatusUnauthorized && !refreshed && credential.hasRefreshToken() {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
			if refreshErr := r.refreshCredential(source.Context(), credential); refreshErr == nil {
				refreshed = true
				attempt--
				continue
			}
		}
		if err == nil && !retryableProviderStatus(response.StatusCode) {
			return response, nil
		}
		if err == nil {
			lastErr = fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
			if attempt+1 >= attempts {
				return response, nil
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
		} else {
			lastErr = err
			if attempt+1 >= attempts {
				break
			}
		}
		delay := time.Duration(1<<min(attempt, 5)) * 100 * time.Millisecond
		if maxRetryInterval > 0 && delay > maxRetryInterval {
			delay = maxRetryInterval
		}
		select {
		case <-time.After(delay):
		case <-source.Context().Done():
			return nil, source.Context().Err()
		}
	}
	return nil, lastErr
}

func (c *nativeCredential) hasRefreshToken() bool {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return c.RefreshToken != ""
}

func (c *nativeCredential) tokenNeedsRefresh() bool {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return c.RefreshToken != "" && !c.expiresAt.IsZero() && time.Now().Add(2*time.Minute).After(c.expiresAt)
}

func (r *nativeRuntime) refreshCredential(ctx context.Context, credential *nativeCredential) error {
	credential.tokenMu.Lock()
	defer credential.tokenMu.Unlock()
	if credential.RefreshToken == "" {
		return errors.New("credential has no refresh token")
	}
	endpoint, clientID := "", ""
	switch credential.Provider {
	case "codex":
		endpoint, clientID = "https://auth.openai.com/oauth/token", codexClientID
	case "kimi":
		endpoint, clientID = "https://auth.kimi.com/api/oauth/token", kimiClientID
	case "xai":
		endpoint, clientID = firstString(credential.document, "token_endpoint"), xaiClientID
	default:
		return errors.New("credential provider does not support token refresh")
	}
	if endpoint == "" {
		return errors.New("credential token endpoint is missing")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {credential.RefreshToken}}
	var tokens map[string]any
	var err error
	if credential.Provider == "kimi" {
		tokens, err = postOAuthFormHeaders(ctx, credential.client, endpoint, form, kimiOAuthHeaders(firstString(credential.document, "device_id")))
	} else {
		tokens, err = postOAuthForm(ctx, credential.client, endpoint, form)
	}
	if err != nil {
		return err
	}
	credential.AccessToken = anyString(tokens["access_token"])
	if refresh := anyString(tokens["refresh_token"]); refresh != "" {
		credential.RefreshToken = refresh
	}
	credential.document["access_token"] = credential.AccessToken
	credential.document["refresh_token"] = credential.RefreshToken
	if idToken := anyString(tokens["id_token"]); idToken != "" {
		credential.document["id_token"] = idToken
	}
	if expires, ok := tokens["expires_in"].(float64); ok && expires > 0 {
		credential.expiresAt = time.Now().Add(time.Duration(expires) * time.Second)
		credential.document["expired"] = credential.expiresAt.UTC().Format(time.RFC3339)
	}
	payload, err := json.Marshal(credential.document)
	if err != nil {
		return err
	}
	credential.Credential.Document = append(credential.Credential.Document[:0], payload...)
	if r.options.OnCredentialUpdated != nil {
		r.options.OnCredentialUpdated(context.WithoutCancel(ctx), credential.ID, append([]byte(nil), payload...))
	}
	return nil
}

func parseCredentialTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}

func retryableProviderStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func (c *nativeCredential) upstreamURL(path string) string {
	base := strings.TrimRight(c.BaseURL, "/")
	if c.Provider == "codex" {
		switch path {
		case "/responses", "/responses/compact", "/alpha/search":
			return base + path
		default:
			return base + "/responses"
		}
	}
	return base + path
}

func (c *nativeCredential) record(success bool, message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if success {
		c.Status.Success++
		c.Status.Status = "active"
		c.Status.StatusMessage = ""
	} else {
		c.Status.Failed++
		c.Status.StatusMessage = message
	}
}

func canonicalInferencePath(path string) string {
	path = strings.TrimSuffix(path, "/")
	for _, prefix := range []string{"/openai/v1", "/backend-api/codex", "/v1"} {
		if strings.HasPrefix(path, prefix) {
			path = strings.TrimPrefix(path, prefix)
			break
		}
	}
	if path == "" {
		return "/responses"
	}
	return path
}

func isResponsesPath(path string) bool { return path == "/responses" || path == "/responses/compact" }
func isChatPath(path string) bool      { return path == "/chat/completions" || path == "/completions" }

func copyProviderHeaders(destination, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "sec-websocket-") {
			continue
		}
		switch lower {
		case "authorization", "x-api-key", "x-goog-api-key", "host", "content-length", "connection", "upgrade",
			"origin", "x-relay-upstream-credential-id":
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func copyResponseHeaders(destination, source http.Header, passthrough bool) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if lower == "content-length" || lower == "connection" || lower == "transfer-encoding" || (!passthrough && lower != "content-type") {
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func writeRuntimeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": code, "code": code, "message": message}})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func jsonString(payload []byte, key string) string {
	var root map[string]any
	_ = json.Unmarshal(payload, &root)
	value, _ := root[key].(string)
	return strings.TrimSpace(value)
}

func jsonBool(payload []byte, key string) bool {
	var root map[string]any
	_ = json.Unmarshal(payload, &root)
	value, _ := root[key].(bool)
	return value
}

func rewriteJSONModel(payload []byte, model string) []byte {
	var root map[string]any
	if json.Unmarshal(payload, &root) != nil || model == "" {
		return payload
	}
	root["model"] = model
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	return encoded
}

var _ Runtime = (*nativeRuntime)(nil)
