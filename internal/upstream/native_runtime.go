package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
	"github.com/tidwall/gjson"
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
	affinity    map[string]affinityEntry
	traces      *requestTraceRegistry
}

type nativeCredential struct {
	mu      sync.Mutex
	tokenMu sync.Mutex
	Credential
	Provider            string
	BaseURL             string
	APIKey              string
	AccessToken         string
	RefreshToken        string
	AccountID           string
	Headers             http.Header
	ProxyURL            string
	WebSockets          bool
	ModelRoutes         map[string]string
	Status              CredentialStatus
	client              *http.Client
	document            map[string]any
	expiresAt           time.Time
	consecutiveFailures int
	probeActive         bool
	SessionAffinity     bool
	Vendor              string
}

// NewRuntime creates the focused Relay runtime for Codex, Kimi, xAI,
// Aliyun Bailian and OpenAI-compatible providers.
func NewRuntime(options Options, credentials []Credential) (Runtime, error) {
	if options.RetryMaxBackoff <= 0 {
		options.RetryMaxBackoff = 2 * time.Second
	}
	if options.FailureThreshold <= 0 {
		options.FailureThreshold = 3
	}
	if options.FailureCooldown < 0 {
		options.FailureCooldown = 0
	}
	r := &nativeRuntime{
		options: options, credentials: make(map[string]*nativeCredential),
		modelRoutes: make(map[string][]string), affinity: make(map[string]affinityEntry),
		traces: newRequestTraceRegistry(),
	}
	r.settings = Settings{
		RequestRetry:    options.RequestRetry,
		RetryMaxBackoff: options.RetryMaxBackoff, RoutingStrategy: options.RoutingStrategy,
		ProxyURL: options.ProxyURL, FailureThreshold: options.FailureThreshold,
		FailureCooldown: options.FailureCooldown,
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
	credential, ok := r.selectCredential(model, "", "")
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
	r.mu.RLock()
	globalProxy := r.settings.ProxyURL
	r.mu.RUnlock()
	compiled, err := compileNativeCredentials(credentials, globalProxy)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.credentials = compiled
	r.rebuildRoutesLocked()
	r.mu.Unlock()
	return nil
}

func compileNativeCredentials(credentials []Credential, globalProxy string) (map[string]*nativeCredential, error) {
	compiled := make(map[string]*nativeCredential, len(credentials))
	for _, source := range credentials {
		if !source.Enabled {
			continue
		}
		credential, err := compileNativeCredential(source, globalProxy)
		if err != nil {
			return nil, err
		}
		compiled[credential.ID] = credential
	}
	return compiled, nil
}

func (r *nativeRuntime) ApplySettings(_ context.Context, settings Settings) error {
	if settings.RoutingStrategy != "" && settings.RoutingStrategy != "round-robin" && settings.RoutingStrategy != "fill-first" {
		return fmt.Errorf("unsupported routing strategy %q", settings.RoutingStrategy)
	}
	if settings.FailureThreshold < 1 || settings.FailureCooldown < 0 {
		return errors.New("credential failure isolation settings are invalid")
	}
	r.mu.RLock()
	credentials := make([]Credential, 0, len(r.credentials))
	previous := make(map[string]*nativeCredential, len(r.credentials))
	for _, credential := range r.credentials {
		credential.tokenMu.Lock()
		source := credential.Credential
		source.Document = append([]byte(nil), source.Document...)
		credential.tokenMu.Unlock()
		credentials = append(credentials, source)
		previous[credential.ID] = credential
	}
	r.mu.RUnlock()
	compiled, err := compileNativeCredentials(credentials, settings.ProxyURL)
	if err != nil {
		return err
	}
	for id, credential := range compiled {
		if old := previous[id]; old != nil {
			old.mu.Lock()
			credential.Status = old.Status
			credential.consecutiveFailures = old.consecutiveFailures
			credential.probeActive = old.probeActive
			old.mu.Unlock()
		}
	}
	if err := r.oauth.applyProxy(settings.ProxyURL); err != nil {
		return fmt.Errorf("apply system proxy: %w", err)
	}
	r.mu.Lock()
	r.settings = settings
	r.credentials = compiled
	r.rebuildRoutesLocked()
	r.mu.Unlock()
	return nil
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

func (r *nativeRuntime) selectCredential(model, pinnedID, affinityKey string) (*nativeCredential, bool) {
	now := time.Now()
	if pinnedID != "" {
		r.mu.RLock()
		credential := r.credentials[pinnedID]
		r.mu.RUnlock()
		return credential, credential != nil && credential.available(now)
	}
	if pinned := r.affinityCredential(affinityKey, model, now); pinned != nil {
		return pinned, true
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := r.modelRoutes[strings.ToLower(strings.TrimSpace(model))]
	if len(ids) == 0 {
		return nil, false
	}
	available := ids[:0]
	for _, id := range ids {
		if credential := r.credentials[id]; credential != nil && credential.available(now) {
			available = append(available, id)
		}
	}
	if len(available) == 0 {
		return nil, false
	}
	index := 0
	if r.settings.RoutingStrategy != "fill-first" {
		index = int(r.next.Add(1)-1) % len(available)
	}
	credential := r.credentials[available[index]]
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
		compatibleOpenAI := (provider == "openai" || provider == "openai-compatibility" || provider == "aliyun-bailian") &&
			(documentProvider == "openai" || documentProvider == "openai-compatibility" || documentProvider == "aliyun-bailian")
		if documentProvider == "" || (documentProvider != provider && !compatibleOpenAI) {
			return nil, fmt.Errorf("upstream credential %q type %q does not match provider %q", source.ID, rawType, source.Provider)
		}
	}
	credential := &nativeCredential{
		Credential: source, Provider: provider, APIKey: firstString(document, "api_key"),
		AccessToken: firstString(document, "access_token", "token"), RefreshToken: firstString(document, "refresh_token"),
		AccountID: firstString(document, "account_id", "chatgpt_account_id"), Headers: make(http.Header),
		ProxyURL: firstString(document, "proxy_url"), ModelRoutes: make(map[string]string),
		Status:   CredentialStatus{Status: "active", PlanType: firstString(document, "plan_type")},
		document: document,
	}
	credential.Vendor = firstString(document, "vendor")
	if affinity, ok := document["session_affinity"].(bool); ok {
		credential.SessionAffinity = affinity
	} else if firstString(document, "session_affinity") == "true" || provider == "aliyun-bailian" {
		credential.SessionAffinity = true
	}
	if provider == "aliyun-bailian" && credential.Vendor == "" {
		credential.Vendor = "aliyun-bailian"
	}
	credential.WebSockets, _ = document["websockets"].(bool)
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
	case "aliyun-bailian", "bailian":
		return "aliyun-bailian"
	case "openai-compatible", "openai-compatibility":
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
	case "aliyun-bailian":
		return "https://dashscope.aliyuncs.com/compatible-mode/v1"
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
	if request.Method == http.MethodGet && strings.TrimRight(request.URL.Path, "/") == "/v1/models" {
		r.ServeModels(w, request)
		return
	}
	if isRuntimeWebSocket(request) {
		r.serveWebSocket(w, request)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<30))
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", "unable to read request")
		return
	}
	r.Serve(w, request, body)
}

func (r *nativeRuntime) Serve(w http.ResponseWriter, request *http.Request, body []byte) {
	r.serveInference(w, request, body)
}

func (r *nativeRuntime) ServeModels(w http.ResponseWriter, request *http.Request) {
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

func (r *nativeRuntime) serveInference(w http.ResponseWriter, request *http.Request, body []byte) {
	requestID := strings.TrimSpace(request.Header.Get("X-Relay-Request-ID"))
	trace := r.beginTrace(requestID)
	defer r.finishTrace(requestID)
	model := jsonString(body, "model")
	pinned := strings.TrimSpace(request.Header.Get("X-Relay-Upstream-Credential-ID"))
	affinityKey := sessionAffinityKey(body, request.Header)
	credential, ok := r.selectCredential(model, pinned, affinityKey)
	if !ok {
		writeRuntimeError(w, http.StatusServiceUnavailable, "model_account_unavailable", "no upstream credential can serve this model")
		return
	}
	r.rememberAffinity(affinityKey, credential)
	upstreamModel := credential.ModelRoutes[strings.ToLower(model)]
	if upstreamModel == "" {
		upstreamModel = model
	}
	body = rewriteJSONModel(body, upstreamModel)
	requestPath := canonicalInferencePath(request.URL.Path)
	responseMode := "passthrough"
	var err error
	var toolRestorer *toolResponseRestorer
	if credential.Provider == "kimi" && isResponsesPath(requestPath) {
		body, err = responsesToChatRequest(body)
		requestPath = "/chat/completions"
		responseMode = "chat-to-responses"
	} else if (credential.Provider == "codex" || credential.Provider == "aliyun-bailian") && isChatPath(requestPath) {
		body, err = chatToResponsesRequest(body)
		requestPath = "/responses"
		responseMode = "responses-to-chat"
	}
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	trace.setSelection(credential, model, responseMode)
	if credential.Provider == "xai" {
		body, toolRestorer = lowerCodexTools(body)
	}
	target := credential.upstreamURL(requestPath)
	response, err := r.doProviderRequest(request, credential, target, body, trace)
	if err != nil {
		r.mu.RLock()
		threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
		r.mu.RUnlock()
		credential.record(false, err.Error(), true, threshold, cooldown)
		writeRuntimeError(w, http.StatusBadGateway, "upstream_connection_failed", err.Error())
		return
	}
	defer response.Body.Close()
	r.mu.RLock()
	threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
	r.mu.RUnlock()
	availabilityFailure := response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden || retryableProviderStatus(response.StatusCode)
	if response.StatusCode < 400 {
		credential.record(true, "", false, threshold, cooldown)
	} else if availabilityFailure {
		credential.record(false, http.StatusText(response.StatusCode), true, threshold, cooldown)
	} else {
		credential.releaseProbe()
	}
	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	stream := jsonBool(body, "stream")
	streamWriter := io.Writer(w)
	if stream && response.StatusCode < http.StatusBadRequest {
		// net/http buffers small writes. Provider SSE events are often only a few
		// hundred bytes, so a plain io.Copy can otherwise hold several events
		// before the outer relay (and therefore the client) sees anything.
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
			streamWriter = immediateFlushWriter{Writer: w, Flusher: flusher}
		}
	}
	if response.StatusCode >= 400 || (responseMode == "passthrough" && toolRestorer == nil) {
		_, _ = io.Copy(streamWriter, response.Body)
		return
	}
	if stream {
		if toolRestorer != nil && responseMode == "passthrough" {
			_ = restoreToolStream(streamWriter, response.Body, toolRestorer)
		} else {
			_ = translateStream(streamWriter, response.Body, responseMode, model)
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

type immediateFlushWriter struct {
	io.Writer
	Flusher http.Flusher
}

func (w immediateFlushWriter) Write(payload []byte) (int, error) {
	written, err := w.Writer.Write(payload)
	if written > 0 {
		w.Flusher.Flush()
	}
	return written, err
}

func (r *nativeRuntime) doProviderRequest(source *http.Request, credential *nativeCredential, target string, body []byte, trace *RequestTrace) (*http.Response, error) {
	r.mu.RLock()
	requestRetry, retryMaxBackoff := r.settings.RequestRetry, r.settings.RetryMaxBackoff
	r.mu.RUnlock()
	attempts := requestRetry + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	refreshed := false
	for index := 0; index < attempts; index++ {
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
		clientTraceState, clientTrace := providerClientTrace()
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), clientTrace))
		attemptStarted := time.Now()
		response, err := credential.client.Do(request)
		snapshot := clientTraceState.snapshot()
		recorded := ExecutionAttempt{
			Number: index + 1, StartedAt: attemptStarted, CompletedAt: time.Now(),
			RequestWrittenAt: snapshot.wroteRequest, FirstResponseAt: snapshot.firstResponseByte,
			GetConnAt: snapshot.getConn, GotConnAt: snapshot.gotConn,
			DNSStartedAt: snapshot.dnsStart, DNSCompletedAt: snapshot.dnsDone,
			ConnectStartedAt: snapshot.connectStart, ConnectCompletedAt: snapshot.connectDone,
			TLSStartedAt: snapshot.tlsStart, TLSCompletedAt: snapshot.tlsDone,
			Provider: credential.Provider, Model: jsonString(body, "model"), CredentialID: credential.ID,
			ConnectionReused: snapshot.reused, RemoteAddr: snapshot.remoteAddr,
		}
		if err != nil {
			recorded.Status, recorded.Error = "failed", err.Error()
		} else if response.StatusCode >= 400 {
			recorded.Status, recorded.Error = "failed", fmt.Sprintf("HTTP %d", response.StatusCode)
			recorded.HeadersAt = snapshot.firstResponseByte
		} else {
			recorded.Status = "complete"
			recorded.HeadersAt = snapshot.firstResponseByte
		}
		trace.addAttempt(recorded)
		if err == nil && response.StatusCode == http.StatusUnauthorized && !refreshed && credential.hasRefreshToken() {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
			if refreshErr := r.refreshCredential(source.Context(), credential); refreshErr == nil {
				refreshed = true
				index--
				continue
			}
		}
		if err == nil && !retryableProviderStatus(response.StatusCode) {
			return response, nil
		}
		if err == nil {
			lastErr = fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
			if index+1 >= attempts {
				return response, nil
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
		} else {
			lastErr = err
			if index+1 >= attempts {
				break
			}
		}
		delay := time.Duration(1<<min(index, 5)) * 100 * time.Millisecond
		if retryMaxBackoff > 0 && delay > retryMaxBackoff {
			delay = retryMaxBackoff
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

func (c *nativeCredential) available(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.Status.Unavailable {
		return true
	}
	if c.Status.NextRetryAfter.IsZero() || now.Before(c.Status.NextRetryAfter) || c.probeActive {
		return false
	}
	c.probeActive = true
	c.Status.Status = "recovering"
	c.Status.StatusMessage = ""
	return true
}

func (c *nativeCredential) record(success bool, message string, availabilityFailure bool, threshold int, cooldown time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if success {
		c.Status.Success++
		c.Status.Status = "active"
		c.Status.StatusMessage = ""
		c.Status.Unavailable = false
		c.Status.NextRetryAfter = time.Time{}
		c.consecutiveFailures = 0
		c.probeActive = false
	} else {
		c.Status.Failed++
		c.Status.StatusMessage = message
		if availabilityFailure {
			wasProbe := c.probeActive
			c.probeActive = false
			c.consecutiveFailures++
			if cooldown > 0 && (wasProbe || c.consecutiveFailures >= threshold) {
				c.Status.Status = "cooldown"
				c.Status.Unavailable = true
				c.Status.NextRetryAfter = time.Now().Add(cooldown)
			}
		}
	}
}

func (c *nativeCredential) releaseProbe() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.probeActive {
		return
	}
	c.probeActive = false
	c.consecutiveFailures = 0
	c.Status.Unavailable = false
	c.Status.Status = "active"
	c.Status.StatusMessage = ""
	c.Status.NextRetryAfter = time.Time{}
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
			"origin", "accept-encoding", "x-relay-upstream-credential-id":
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func copyResponseHeaders(destination, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if lower != "content-type" && lower != "retry-after" && lower != "x-request-id" &&
			lower != "request-id" && !strings.HasPrefix(lower, "x-ratelimit-") && !strings.HasPrefix(lower, "openai-") {
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
	return strings.TrimSpace(gjson.GetBytes(payload, key).String())
}

func jsonBool(payload []byte, key string) bool {
	return gjson.GetBytes(payload, key).Bool()
}

func rewriteJSONModel(payload []byte, model string) []byte {
	if model == "" || jsonString(payload, "model") == model {
		return payload
	}
	var root map[string]any
	if json.Unmarshal(payload, &root) != nil {
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
