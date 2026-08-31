package upstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
)

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

func compileNativeCredentials(credentials []Credential, globalProxy string, headerTimeout time.Duration) (map[string]*nativeCredential, error) {
	compiled := make(map[string]*nativeCredential, len(credentials))
	for _, source := range credentials {
		if !source.Enabled {
			continue
		}
		credential, err := compileNativeCredential(source, globalProxy, headerTimeout)
		if err != nil {
			return nil, err
		}
		compiled[credential.ID] = credential
	}
	return compiled, nil
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
			r.modelRoutes[key] = appendUniqueRoute(r.modelRoutes[key], id)
			modelSet[key] = public
		}
		for _, model := range implicitProviderImageModels(credential.Provider) {
			key := strings.ToLower(model)
			r.modelRoutes[key] = appendUniqueRoute(r.modelRoutes[key], id)
			if _, exists := modelSet[key]; !exists {
				modelSet[key] = model
			}
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

func compileNativeCredential(source Credential, globalProxy string, headerTimeout time.Duration) (*nativeCredential, error) {
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
	if provider == "kimi" {
		applyDefaultKimiCodingPlanRoutes(credential.ModelRoutes)
	}
	credential.Models = normalizedModelList(source.Models)
	if len(credential.Models) == 0 {
		credential.Models = defaultModels(provider)
	}
	client, err := providerHTTPClient(credential.ProxyURL, headerTimeout)
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

// applyDefaultKimiCodingPlanRoutes maps Relay catalog slugs to Kimi Coding
// Plan wire IDs. Document model_routes win when already set. Production 401:
// "Your model id does not exist, recognized as other:kimi-k3-256k. Please set model id as `k3`."
func applyDefaultKimiCodingPlanRoutes(routes map[string]string) {
	if routes == nil {
		return
	}
	for public, upstream := range map[string]string{
		"kimi-k3":      "k3",
		"kimi-k3-256k": "k3",
	} {
		if _, exists := routes[public]; !exists {
			routes[public] = upstream
		}
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

func providerHTTPClient(proxyURL string, headerTimeout time.Duration) (*http.Client, error) {
	return egress.OutboundHTTPClient(proxyURL, headerTimeout)
}

func (c *nativeCredential) discoverModels(ctx context.Context) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.BaseURL, "/")+"/models", nil)
	if err != nil {
		return nil, err
	}
	c.authorize(request.Header, "")
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

func (c *nativeCredential) authorize(header http.Header, path string) {
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
		if header.Get("OpenAI-Beta") == "" && !isImagesPath(path) {
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

func (c *nativeCredential) hasRefreshToken() bool {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return c.RefreshToken != ""
}

const credentialRefreshLead = 5 * time.Minute

func (c *nativeCredential) tokenNeedsRefresh() bool {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return credentialTokenNeedsRefresh(c.RefreshToken, c.expiresAt, time.Now())
}

func credentialTokenNeedsRefresh(refreshToken string, expiresAt, now time.Time) bool {
	if strings.TrimSpace(refreshToken) == "" {
		return false
	}
	if expiresAt.IsZero() {
		return true
	}
	return !now.Add(credentialRefreshLead).Before(expiresAt)
}

func (c *nativeCredential) currentDocument() []byte {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return append([]byte(nil), c.Credential.Document...)
}

func parseCredentialTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed
	}
	return time.Time{}
}

func providerAvailabilityStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func (c *nativeCredential) upstreamURL(path string) string {
	base := strings.TrimRight(c.BaseURL, "/")
	if c.Provider == "codex" {
		switch path {
		case "/responses", "/responses/compact", "/alpha/search", "/images/generations", "/images/edits":
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
