package relaybridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/api"
	codexauth "github.com/router-for-me/CLIProxyAPI/v7/internal/auth/codex"
	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/wsrelay"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v7/sdk/access"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
	"golang.org/x/crypto/bcrypt"
)

// Keep transport failures briefly unavailable only when credential cooling is
// explicitly enabled by Relay's runtime settings.
const transientCredentialCooldownSeconds = 1

const maxDiscoveredModelCatalogBytes int64 = 16 << 20

const credentialSessionAffinityTTL = time.Hour

// Credential is Relay's storage-neutral representation of one CPA credential.
// Document is the original CPA auth JSON (or a config-derived API-key document).
type Credential struct {
	ID       string
	Label    string
	Provider string
	Enabled  bool
	Models   []string
	Document []byte
}

// Options controls the embedded CPA inference server.
type Options struct {
	APIKey                     string
	RequestRetry               int
	MaxRetryCredentials        int
	MaxRetryInterval           time.Duration
	RoutingStrategy            string
	ProxyURL                   string
	PassthroughHeaders         bool
	DisableImageGeneration     string
	GPTImage2BaseModel         string
	VideoResultAuthCacheTTL    string
	ForceModelPrefix           bool
	StreamKeepAliveSeconds     int
	StreamBootstrapRetries     int
	NonStreamKeepAliveInterval int
	DisableCredentialCooling   bool
	OnCredentialUpdated        func(context.Context, string, []byte)
	OnOAuthCredential          func(context.Context, string, string, string, []byte) error
}

// Settings is the hot-reloadable subset of the embedded CPA configuration.
type Settings struct {
	RequestRetry               int
	MaxRetryCredentials        int
	MaxRetryInterval           time.Duration
	RoutingStrategy            string
	ProxyURL                   string
	PassthroughHeaders         bool
	DisableImageGeneration     string
	GPTImage2BaseModel         string
	VideoResultAuthCacheTTL    string
	ForceModelPrefix           bool
	StreamKeepAliveSeconds     int
	StreamBootstrapRetries     int
	NonStreamKeepAliveInterval int
	DisableCredentialCooling   bool
}

// CredentialStatus is the secret-free runtime state CPA tracks for one
// credential. It intentionally excludes attributes, metadata, tokens and
// provider error payloads so Relay can expose operational health safely.
type CredentialStatus struct {
	Status          string
	StatusMessage   string
	Unavailable     bool
	Success         int64
	Failed          int64
	PlanType        string
	LastRefreshedAt time.Time
	NextRetryAfter  time.Time
	QuotaExceeded   bool
	QuotaReason     string
	QuotaRecoverAt  time.Time
}

// Runtime owns CPA's complete public inference router and provider runtime.
// The management surface is not exposed publicly; when OAuth is enabled, Relay
// calls a password-protected in-process subset through the broker in oauth.go.
type Runtime struct {
	mu               sync.RWMutex
	cfg              *internalconfig.Config
	manager          *coreauth.Manager
	handler          http.Handler
	server           *api.Server
	wsGateway        *wsrelay.Manager
	routes           map[string]credentialRoute
	modelRoutes      map[string]credentialRoute
	modelNames       map[string]string
	authIDs          map[string]struct{}
	credentials      []Credential
	globalProxy      string
	managementSecret string
	oauthDir         string
	traces           *requestTraceRegistry
	routingStrategy  string
}

type credentialRoute struct {
	provider string
	models   map[string]modelRoute
}

type modelRoute struct {
	upstream string
	image    bool
}

// NewRuntime builds an in-process CPA server with the same handlers used by
// the standalone binary, including image, video, compact, token-counting,
// Gemini native, realtime and WebSocket routes.
func NewRuntime(opts Options, credentials []Credential) (*Runtime, error) {
	apiKey := strings.TrimSpace(opts.APIKey)
	if apiKey == "" {
		return nil, fmt.Errorf("embedded CPA API key is required")
	}
	maxRetryInterval := int(opts.MaxRetryInterval / time.Second)
	if maxRetryInterval < 0 {
		maxRetryInterval = 0
	}
	cfg := &internalconfig.Config{
		SDKConfig: internalconfig.SDKConfig{
			APIKeys:                    []string{apiKey},
			PassthroughHeaders:         opts.PassthroughHeaders,
			ProxyURL:                   strings.TrimSpace(opts.ProxyURL),
			GPTImage2BaseModel:         strings.TrimSpace(opts.GPTImage2BaseModel),
			VideoResultAuthCacheTTL:    strings.TrimSpace(opts.VideoResultAuthCacheTTL),
			ForceModelPrefix:           opts.ForceModelPrefix,
			Streaming:                  internalconfig.StreamingConfig{KeepAliveSeconds: opts.StreamKeepAliveSeconds, BootstrapRetries: opts.StreamBootstrapRetries},
			NonStreamKeepAliveInterval: opts.NonStreamKeepAliveInterval,
		},
		CommercialMode:                true,
		WebsocketAuth:                 true,
		DisableCooling:                opts.DisableCredentialCooling,
		RequestRetry:                  opts.RequestRetry,
		MaxRetryCredentials:           opts.MaxRetryCredentials,
		MaxRetryInterval:              maxRetryInterval,
		TransientErrorCooldownSeconds: credentialCooldownSeconds(opts.DisableCredentialCooling),
		// Official Codex clients emit agent_message / collaboration items for
		// collab_spawn. xAI (and other non-Codex Responses hosts) reject that
		// shape as 422 Unprocessable Entity unless CPA rewrites it first.
		Codex: internalconfig.CodexConfig{OptimizeMultiAgentV2: true},
	}
	cfg.DisableImageGeneration = imageGenerationMode(opts.DisableImageGeneration)
	routingStrategy := normalizedRoutingStrategy(opts.RoutingStrategy)
	manager := coreauth.NewManager(nil, newCredentialSelector(routingStrategy), runtimeAuthHook{updated: opts.OnCredentialUpdated})
	manager.SetRetryConfig(opts.RequestRetry, opts.MaxRetryInterval, opts.MaxRetryCredentials)
	accessManager := sdkaccess.NewManager()
	runtime := &Runtime{
		cfg: cfg, manager: manager, routes: make(map[string]credentialRoute),
		modelRoutes: make(map[string]credentialRoute), modelNames: make(map[string]string), authIDs: make(map[string]struct{}), globalProxy: strings.TrimSpace(opts.ProxyURL),
		traces: newRequestTraceRegistry(), routingStrategy: routingStrategy,
	}
	if opts.OnOAuthCredential != nil {
		oauthDir, errTemp := os.MkdirTemp("", "relayapi-oauth-")
		if errTemp != nil {
			return nil, fmt.Errorf("create OAuth workspace: %w", errTemp)
		}
		var secretBytes [32]byte
		if _, errRandom := rand.Read(secretBytes[:]); errRandom != nil {
			_ = os.RemoveAll(oauthDir)
			return nil, fmt.Errorf("generate OAuth management secret: %w", errRandom)
		}
		runtime.oauthDir = oauthDir
		runtime.managementSecret = hex.EncodeToString(secretBytes[:])
		cfg.AuthDir = oauthDir
		managementHash, errHash := bcrypt.GenerateFromPassword([]byte(runtime.managementSecret), bcrypt.DefaultCost)
		if errHash != nil {
			_ = os.RemoveAll(oauthDir)
			return nil, fmt.Errorf("hash OAuth management secret: %w", errHash)
		}
		cfg.RemoteManagement.SecretKey = string(managementHash)
	}
	runtime.wsGateway = wsrelay.NewManager(wsrelay.Options{Path: "/v1/ws"})
	runtime.registerBaselineExecutors()

	var engine *gin.Engine
	serverOptions := []api.ServerOption{
		api.WithMiddleware(runtime.requestTraceMiddleware(), runtime.pinCredentialMiddleware()),
		api.WithEngineConfigurator(func(value *gin.Engine) { engine = value }),
		api.WithRouterConfigurator(func(_ *gin.Engine, base *handlers.BaseAPIHandler, _ *internalconfig.Config) {
			base.SetModelRouterHost(runtime)
		}),
	}
	previousStore := sdkauth.GetTokenStore()
	if opts.OnOAuthCredential != nil {
		captureStore := newOAuthCaptureStore(runtime.oauthDir, opts.OnOAuthCredential)
		sdkauth.RegisterTokenStore(captureStore)
		defer sdkauth.RegisterTokenStore(previousStore)
		serverOptions = append(serverOptions, api.WithLocalManagementPassword(runtime.managementSecret))
	}
	server := api.NewServer(cfg, manager, accessManager, "", serverOptions...)
	if engine == nil {
		_ = os.RemoveAll(runtime.oauthDir)
		return nil, fmt.Errorf("embedded CPA router was not initialized")
	}
	server.AttachWebsocketRoute(runtime.wsGateway.Path(), runtime.wsGateway.Handler())
	runtime.server = server
	runtime.handler = engine
	if err := runtime.ReplaceCredentials(context.Background(), credentials); err != nil {
		_ = runtime.Close(context.Background())
		return nil, err
	}
	manager.StartAutoRefresh(context.Background(), 15*time.Minute)
	return runtime, nil
}

type runtimeAuthHook struct {
	updated func(context.Context, string, []byte)
}

func (runtimeAuthHook) OnAuthRegistered(context.Context, *coreauth.Auth) {}

func (runtimeAuthHook) OnResult(context.Context, coreauth.Result) {}

func (h runtimeAuthHook) OnAuthUpdated(ctx context.Context, auth *coreauth.Auth) {
	if h.updated == nil || auth == nil || auth.ID == "" || auth.Metadata == nil {
		return
	}
	payload, err := json.Marshal(auth.Metadata)
	if err == nil {
		h.updated(ctx, auth.ID, payload)
	}
}

func (r *Runtime) registerBaselineExecutors() {
	for _, exec := range []coreauth.ProviderExecutor{
		executor.NewCodexAutoExecutor(r.cfg),
		executor.NewXAIAutoExecutor(r.cfg),
		executor.NewClaudeExecutor(r.cfg),
		executor.NewGeminiExecutor(r.cfg),
		executor.NewGeminiInteractionsExecutor(r.cfg),
		executor.NewGeminiVertexExecutor(r.cfg),
		executor.NewAIStudioExecutor(r.cfg, "aistudio", r.wsGateway),
		executor.NewAntigravityExecutor(r.cfg),
		executor.NewKimiExecutor(r.cfg),
		executor.NewOpenAICompatExecutor("openai", r.cfg),
		executor.NewOpenAICompatExecutor("openai-compatibility", r.cfg),
	} {
		r.manager.RegisterExecutor(observeExecutor(exec, r.traces))
	}
}

// Handler returns CPA's public inference HTTP handler.
func (r *Runtime) Handler() http.Handler { return r.handler }

// TakeRequestTrace returns and removes the CPA-internal trace for one Relay
// request. Relay calls this after the downstream response has completed so
// long streaming traces do not need to cross an HTTP response header.
func (r *Runtime) TakeRequestTrace(requestID string) (RequestTrace, bool) {
	if r == nil {
		return RequestTrace{}, false
	}
	return r.traces.take(requestID)
}

// RequestTraceSnapshot returns a non-consuming copy for a completed turn of a
// long-lived WebSocket request. The final session still consumes the trace.
func (r *Runtime) RequestTraceSnapshot(requestID string) (RequestTrace, bool) {
	if r == nil {
		return RequestTrace{}, false
	}
	return r.traces.snapshot(requestID)
}

// CredentialCount reports the number of enabled credentials installed.
func (r *Runtime) CredentialCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.authIDs)
}

// Models returns the configured public model names.
func (r *Runtime) Models() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	models := make([]string, 0, len(r.modelNames))
	for _, model := range r.modelNames {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

// CredentialModels returns the public models CPA registered for one
// credential. Unlike the unified /v1/models catalog, this preserves the
// credential boundary used by Relay's subscription admission.
func (r *Runtime) CredentialModels(id string) []string {
	id = strings.TrimSpace(id)
	if r == nil || id == "" {
		return nil
	}
	r.mu.RLock()
	route, ok := r.routes[id]
	r.mu.RUnlock()
	if !ok {
		return nil
	}
	models := make([]string, 0, len(route.models))
	for model := range route.models {
		if model = strings.TrimSpace(model); model != "" {
			models = append(models, model)
		}
	}
	sort.Strings(models)
	return models
}

// CredentialStatus returns CPA's current scheduler and refresh state for one
// installed credential without exposing the credential document.
func (r *Runtime) CredentialStatus(id string) (CredentialStatus, bool) {
	id = strings.TrimSpace(id)
	if r == nil || id == "" || r.manager == nil {
		return CredentialStatus{}, false
	}
	auth, ok := r.manager.GetByID(id)
	if !ok || auth == nil {
		return CredentialStatus{}, false
	}
	return CredentialStatus{
		Status:          string(auth.Status),
		StatusMessage:   strings.TrimSpace(auth.StatusMessage),
		Unavailable:     auth.Unavailable,
		Success:         auth.Success,
		Failed:          auth.Failed,
		PlanType:        strings.TrimSpace(auth.Attributes["plan_type"]),
		LastRefreshedAt: auth.LastRefreshedAt,
		NextRetryAfter:  auth.NextRetryAfter,
		QuotaExceeded:   auth.Quota.Exceeded,
		QuotaReason:     strings.TrimSpace(auth.Quota.Reason),
		QuotaRecoverAt:  auth.Quota.NextRecoverAt,
	}, true
}

// DiscoverCredentialModels asks CPA for the best credential-scoped model
// catalog it can provide. OpenAI-compatible credentials are probed through
// CPA's executor so credential headers, custom headers and proxy policy are
// identical to inference requests. Other providers use CPA's registered
// provider catalog. A registry fallback may be returned together with a probe
// error so callers can keep serving the last known-good list.
func (r *Runtime) DiscoverCredentialModels(ctx context.Context, id string) ([]string, string, error) {
	id = strings.TrimSpace(id)
	if r == nil || id == "" {
		return nil, "", fmt.Errorf("CPA credential requires an ID")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	auth, ok := r.manager.GetByID(id)
	if !ok || auth == nil {
		return nil, "", fmt.Errorf("CPA credential %q is not registered", id)
	}
	fallback := r.CredentialModels(id)
	if !isOpenAICompatibleAuth(auth) {
		models := modelIDs(cpaStaticModelsForAuth(auth.Provider, auth))
		if len(models) > 0 {
			return models, "cpa_static", nil
		}
		if len(fallback) == 0 {
			return nil, "", fmt.Errorf("CPA has no models registered for credential %q", id)
		}
		return fallback, "cpa_registry", nil
	}
	baseURL := strings.TrimSpace(auth.Attributes["base_url"])
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		err = fmt.Errorf("CPA credential %q requires an absolute base_url for model discovery", id)
		if len(fallback) > 0 {
			return fallback, "cpa_registry", err
		}
		return nil, "", err
	}
	targetURL := strings.TrimRight(parsed.String(), "/") + "/models"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return fallback, fallbackModelSource(fallback), err
	}
	request.Header.Set("Accept", "application/json")
	response, err := r.manager.HttpRequest(ctx, auth, request)
	if err != nil {
		return fallback, fallbackModelSource(fallback), fmt.Errorf("CPA model discovery failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		err = fmt.Errorf("CPA model discovery returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
		return fallback, fallbackModelSource(fallback), err
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxDiscoveredModelCatalogBytes+1))
	if err != nil {
		return fallback, fallbackModelSource(fallback), fmt.Errorf("read CPA model catalog: %w", err)
	}
	if int64(len(payload)) > maxDiscoveredModelCatalogBytes {
		return fallback, fallbackModelSource(fallback), fmt.Errorf("CPA model catalog exceeds %d bytes", maxDiscoveredModelCatalogBytes)
	}
	models, err := decodeDiscoveredModels(payload)
	if err != nil {
		return fallback, fallbackModelSource(fallback), err
	}
	models = filterExcludedModelIDs(models, auth)
	if len(models) == 0 {
		err = fmt.Errorf("CPA model discovery returned an empty catalog")
		return fallback, fallbackModelSource(fallback), err
	}
	return models, "cpa_upstream", nil
}

func cpaStaticModelsForAuth(provider string, auth *coreauth.Auth) []*registry.ModelInfo {
	provider = normalizeProvider(provider)
	var models []*registry.ModelInfo
	if provider != "codex" {
		models = registry.GetStaticModelDefinitionsByChannel(provider)
		return applyCPAAuthModelAliases(filterCPAExcludedModels(models, auth), auth)
	}
	planType := ""
	if auth != nil {
		planType = strings.ToLower(strings.TrimSpace(auth.Attributes["plan_type"]))
	}
	switch planType {
	case "free":
		models = registry.GetCodexFreeModels()
	case "team", "business", "go":
		models = registry.GetCodexTeamModels()
	case "plus":
		models = registry.GetCodexPlusModels()
	default:
		models = registry.GetCodexProModels()
	}
	return applyCPAAuthModelAliases(filterCPAExcludedModels(models, auth), auth)
}

func applyCPAAuthModelAliases(models []*registry.ModelInfo, auth *coreauth.Auth) []*registry.ModelInfo {
	if len(models) == 0 || auth == nil {
		return models
	}
	aliases := coreauth.OAuthModelAliasesFromAttributes(auth.Attributes)
	if len(aliases) == 0 {
		return models
	}
	byModel := make(map[string][]internalconfig.OAuthModelAlias, len(aliases))
	for _, alias := range aliases {
		name := strings.ToLower(strings.TrimSpace(alias.Name))
		if name != "" && strings.TrimSpace(alias.Alias) != "" && !strings.EqualFold(alias.Name, alias.Alias) {
			byModel[name] = append(byModel[name], alias)
		}
	}
	result := make([]*registry.ModelInfo, 0, len(models)+len(aliases))
	seen := make(map[string]struct{}, len(models)+len(aliases))
	for _, model := range models {
		if model == nil || strings.TrimSpace(model.ID) == "" {
			continue
		}
		entries := byModel[strings.ToLower(strings.TrimSpace(model.ID))]
		keepOriginal := len(entries) == 0
		for _, alias := range entries {
			if alias.Fork {
				keepOriginal = true
			}
		}
		if keepOriginal {
			key := strings.ToLower(strings.TrimSpace(model.ID))
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				result = append(result, model)
			}
		}
		for _, alias := range entries {
			aliasID := strings.TrimSpace(alias.Alias)
			key := strings.ToLower(aliasID)
			if aliasID == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			cloned := *model
			cloned.ID = aliasID
			if displayName := strings.TrimSpace(alias.DisplayName); displayName != "" {
				cloned.DisplayName = displayName
			}
			result = append(result, &cloned)
		}
	}
	return result
}

func filterCPAExcludedModels(models []*registry.ModelInfo, auth *coreauth.Auth) []*registry.ModelInfo {
	if len(models) == 0 || auth == nil {
		return models
	}
	excluded := make(map[string]struct{})
	for _, model := range strings.Split(auth.Attributes["excluded_models"], ",") {
		if model = strings.ToLower(strings.TrimSpace(model)); model != "" {
			excluded[model] = struct{}{}
		}
	}
	if len(excluded) == 0 {
		return models
	}
	filtered := make([]*registry.ModelInfo, 0, len(models))
	for _, model := range models {
		if model == nil {
			continue
		}
		if _, skip := excluded[strings.ToLower(strings.TrimSpace(model.ID))]; !skip {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func modelIDs(infos []*registry.ModelInfo) []string {
	seen := make(map[string]string, len(infos))
	for _, info := range infos {
		if info == nil {
			continue
		}
		model := strings.TrimSpace(info.ID)
		if model != "" {
			seen[strings.ToLower(model)] = model
		}
	}
	models := make([]string, 0, len(seen))
	for _, model := range seen {
		models = append(models, model)
	}
	sort.Slice(models, func(i, j int) bool { return strings.ToLower(models[i]) < strings.ToLower(models[j]) })
	return models
}

func isOpenAICompatibleAuth(auth *coreauth.Auth) bool {
	if auth == nil {
		return false
	}
	provider := normalizeProvider(auth.Provider)
	if provider == "openai" || provider == "openai-compatibility" {
		return true
	}
	compatName := strings.ToLower(strings.TrimSpace(auth.Attributes["compat_name"]))
	return compatName == "openai" || compatName == "openai-compatibility"
}

func fallbackModelSource(models []string) string {
	if len(models) > 0 {
		return "cpa_registry"
	}
	return ""
}

func decodeDiscoveredModels(payload []byte) ([]string, error) {
	type modelEntry struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Model string `json:"model"`
	}
	var catalog struct {
		Data   []modelEntry `json:"data"`
		Models []modelEntry `json:"models"`
		Output struct {
			Models []modelEntry `json:"models"`
		} `json:"output"`
	}
	if err := json.Unmarshal(payload, &catalog); err != nil {
		return nil, fmt.Errorf("decode CPA model catalog: %w", err)
	}
	entries := append(append(catalog.Data, catalog.Models...), catalog.Output.Models...)
	seen := make(map[string]string, len(entries))
	for _, entry := range entries {
		model := strings.TrimSpace(entry.ID)
		if model == "" {
			model = strings.TrimSpace(entry.Model)
		}
		if model == "" {
			model = strings.TrimSpace(entry.Name)
		}
		if model != "" {
			seen[strings.ToLower(model)] = model
		}
	}
	models := make([]string, 0, len(seen))
	for _, model := range seen {
		models = append(models, model)
	}
	sort.Slice(models, func(i, j int) bool { return strings.ToLower(models[i]) < strings.ToLower(models[j]) })
	return models, nil
}

// ReplaceCredentials atomically replaces Relay-owned auth records and their
// model registrations while leaving CPA executor state intact.
func (r *Runtime) ReplaceCredentials(ctx context.Context, credentials []Credential) error {
	if ctx == nil {
		ctx = context.Background()
	}
	type compiledCredential struct {
		auth   *coreauth.Auth
		route  credentialRoute
		models []*registry.ModelInfo
	}
	compiled := make([]compiledCredential, 0, len(credentials))
	for _, item := range credentials {
		if !item.Enabled {
			continue
		}
		auth, route, models, err := compileCredential(item, r.globalProxy)
		if err != nil {
			return err
		}
		compiled = append(compiled, compiledCredential{auth: auth, route: route, models: models})
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	nextIDs := make(map[string]struct{}, len(compiled))
	for _, item := range compiled {
		nextIDs[item.auth.ID] = struct{}{}
	}
	for id := range r.authIDs {
		if _, keep := nextIDs[id]; !keep {
			r.manager.Remove(ctx, id)
			registry.GetGlobalRegistry().UnregisterClient(id)
		}
	}
	r.routes = make(map[string]credentialRoute, len(compiled))
	r.modelRoutes = make(map[string]credentialRoute)
	r.modelNames = make(map[string]string)
	r.authIDs = make(map[string]struct{}, len(compiled))
	r.credentials = append([]Credential(nil), credentials...)
	for _, item := range compiled {
		provider := item.route.provider
		r.ensureExecutor(provider)
		if previous, exists := r.manager.GetByID(item.auth.ID); exists && credentialAffinityScopeEqual(previous, item.auth) {
			if _, err := r.manager.Update(ctx, item.auth); err != nil {
				return fmt.Errorf("update CPA credential %q: %w", item.auth.ID, err)
			}
		} else {
			if exists {
				r.manager.Remove(ctx, item.auth.ID)
			}
			if _, err := r.manager.Register(ctx, item.auth); err != nil {
				return fmt.Errorf("register CPA credential %q: %w", item.auth.ID, err)
			}
		}
		r.authIDs[item.auth.ID] = struct{}{}
		r.routes[item.auth.ID] = item.route
		for public := range item.route.models {
			key := strings.ToLower(public)
			r.modelRoutes[key] = item.route
			r.modelNames[key] = public
		}
		registry.GetGlobalRegistry().UnregisterClient(item.auth.ID)
		registry.GetGlobalRegistry().RegisterClient(item.auth.ID, provider, item.models)
	}
	return nil
}

func credentialAffinityScopeEqual(left, right *coreauth.Auth) bool {
	if left == nil || right == nil || left.Provider != right.Provider {
		return false
	}
	for _, key := range []string{"base_url", "account_id", "project_id", "location", "region", "vendor"} {
		if strings.TrimSpace(left.Attributes[key]) != strings.TrimSpace(right.Attributes[key]) {
			return false
		}
	}
	return true
}

// ApplySettings updates the runtime configuration used by handlers and the
// credential scheduler. Existing credentials are recompiled so a changed
// global proxy takes effect immediately without restarting RelayAPI.
func (r *Runtime) ApplySettings(ctx context.Context, settings Settings) error {
	if r == nil {
		return fmt.Errorf("embedded CPA runtime is not available")
	}
	r.mu.Lock()
	r.cfg.RequestRetry = settings.RequestRetry
	r.cfg.MaxRetryCredentials = settings.MaxRetryCredentials
	r.cfg.MaxRetryInterval = int(settings.MaxRetryInterval / time.Second)
	r.cfg.ProxyURL = strings.TrimSpace(settings.ProxyURL)
	r.cfg.PassthroughHeaders = settings.PassthroughHeaders
	r.cfg.DisableImageGeneration = imageGenerationMode(settings.DisableImageGeneration)
	r.cfg.GPTImage2BaseModel = strings.TrimSpace(settings.GPTImage2BaseModel)
	r.cfg.VideoResultAuthCacheTTL = strings.TrimSpace(settings.VideoResultAuthCacheTTL)
	r.cfg.ForceModelPrefix = settings.ForceModelPrefix
	r.cfg.Streaming.KeepAliveSeconds = settings.StreamKeepAliveSeconds
	r.cfg.Streaming.BootstrapRetries = settings.StreamBootstrapRetries
	r.cfg.NonStreamKeepAliveInterval = settings.NonStreamKeepAliveInterval
	r.cfg.DisableCooling = settings.DisableCredentialCooling
	r.cfg.TransientErrorCooldownSeconds = credentialCooldownSeconds(settings.DisableCredentialCooling)
	r.globalProxy = strings.TrimSpace(settings.ProxyURL)
	routingStrategy := normalizedRoutingStrategy(settings.RoutingStrategy)
	strategyChanged := routingStrategy != r.routingStrategy
	r.routingStrategy = routingStrategy
	credentials := append([]Credential(nil), r.credentials...)
	r.mu.Unlock()
	if strategyChanged {
		r.manager.SetSelector(newCredentialSelector(routingStrategy))
	}
	r.manager.SetRetryConfig(settings.RequestRetry, settings.MaxRetryInterval, settings.MaxRetryCredentials)
	coreauth.SetQuotaCooldownDisabled(settings.DisableCredentialCooling)
	coreauth.SetTransientErrorCooldownSeconds(credentialCooldownSeconds(settings.DisableCredentialCooling))
	r.manager.SetConfig(r.cfg)
	return r.ReplaceCredentials(ctx, credentials)
}

func normalizedRoutingStrategy(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "fill-first") {
		return "fill-first"
	}
	return "round-robin"
}

func newCredentialSelector(strategy string) coreauth.Selector {
	var fallback coreauth.Selector = &coreauth.RoundRobinSelector{}
	if normalizedRoutingStrategy(strategy) == "fill-first" {
		fallback = &coreauth.FillFirstSelector{}
	}
	return coreauth.NewSessionAffinitySelectorWithConfig(coreauth.SessionAffinityConfig{
		Fallback:      fallback,
		TTL:           credentialSessionAffinityTTL,
		AuthAttribute: "session_affinity",
	})
}

func credentialCooldownSeconds(disabled bool) int {
	if disabled {
		return -1
	}
	return transientCredentialCooldownSeconds
}

func imageGenerationMode(value string) internalconfig.DisableImageGenerationMode {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "all":
		return internalconfig.DisableImageGenerationAll
	case "chat":
		return internalconfig.DisableImageGenerationChat
	case "passthrough":
		return internalconfig.DisableImageGenerationPassthrough
	default:
		return internalconfig.DisableImageGenerationOff
	}
}

func (r *Runtime) ensureExecutor(provider string) {
	if _, ok := r.manager.Executor(provider); ok {
		return
	}
	r.manager.RegisterExecutor(observeExecutor(executor.NewOpenAICompatExecutor(provider, r.cfg), r.traces))
}

func compileCredential(item Credential, globalProxy string) (*coreauth.Auth, credentialRoute, []*registry.ModelInfo, error) {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		return nil, credentialRoute{}, nil, fmt.Errorf("CPA credential requires an ID")
	}
	var metadata map[string]any
	if err := json.Unmarshal(item.Document, &metadata); err != nil {
		return nil, credentialRoute{}, nil, fmt.Errorf("decode CPA credential %q: %w", id, err)
	}
	credentialProvider := normalizeProvider(item.Provider)
	provider := credentialProvider
	if rawType, _ := metadata["type"].(string); strings.TrimSpace(rawType) != "" {
		provider = normalizeProvider(rawType)
	}
	if provider == "" {
		return nil, credentialRoute{}, nil, fmt.Errorf("CPA credential %q requires a provider", id)
	}
	attrs := make(map[string]string)
	for _, key := range []string{
		"api_key", "base_url", "compat_name", "provider_key", "account_id", "project_id",
		"location", "region", "priority", "prefix", "cloak_mode", "token_endpoint",
		"plan_type", "auth_kind", "upstream_api", "vendor", "cache_mode", "session_affinity",
	} {
		if value, ok := metadata[key].(string); ok && strings.TrimSpace(value) != "" {
			attrs[key] = strings.TrimSpace(value)
		}
	}
	if provider == "openai" || provider == "openai-compatibility" {
		attrs["compat_name"] = provider
		attrs["provider_key"] = provider
	}
	if credentialProvider == "aliyun-bailian" {
		attrs["vendor"] = "aliyun-bailian"
		attrs["session_affinity"] = "true"
		if strings.TrimSpace(attrs["upstream_api"]) == "" {
			attrs["upstream_api"] = "auto"
		}
		if strings.TrimSpace(attrs["cache_mode"]) == "" {
			attrs["cache_mode"] = "auto"
		}
	}
	proxyURL := stringValue(metadata, "proxy_url")
	if proxyURL == "" {
		proxyURL = strings.TrimSpace(globalProxy)
	}
	label := strings.TrimSpace(item.Label)
	if label == "" {
		label = id
	}
	auth := &coreauth.Auth{
		ID: id, Provider: provider, Label: label, Status: coreauth.StatusActive,
		Prefix:   stringValue(metadata, "prefix"),
		ProxyURL: proxyURL, Attributes: attrs, Metadata: metadata,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if provider == "codex" && strings.TrimSpace(auth.Attributes["plan_type"]) == "" {
		if idToken := stringValue(metadata, "id_token"); idToken != "" {
			if claims, parseErr := codexauth.ParseJWTToken(idToken); parseErr == nil && claims != nil {
				auth.Attributes["plan_type"] = strings.TrimSpace(claims.CodexAuthInfo.ChatgptPlanType)
			}
		}
	}
	applyCPAAuthModelMetadata(auth, metadata)
	coreauth.ApplyCustomHeadersFromMetadata(auth)
	if err := coreauth.ValidateAuthWeight(auth); err != nil {
		return nil, credentialRoute{}, nil, fmt.Errorf("CPA credential %q has invalid weight: %w", id, err)
	}

	aliases := modelAliases(metadata)
	publicModels := append([]string(nil), item.Models...)
	if len(publicModels) == 0 {
		publicModels = modelIDs(cpaStaticModelsForAuth(provider, auth))
	}
	publicModels = filterExcludedModelIDs(publicModels, auth)
	route := credentialRoute{provider: provider, models: make(map[string]modelRoute)}
	modelInfos := make([]*registry.ModelInfo, 0, len(publicModels)*2)
	seen := make(map[string]struct{})
	for _, public := range publicModels {
		public = strings.TrimSpace(public)
		if public == "" {
			continue
		}
		alias := aliases[strings.ToLower(public)]
		upstream := alias.upstream
		if upstream == "" {
			upstream = public
		}
		route.models[public] = modelRoute{upstream: upstream, image: alias.image}
		for _, model := range []string{public, upstream} {
			key := strings.ToLower(strings.TrimSpace(model))
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			lookupID := model
			if strings.EqualFold(model, public) && upstream != "" {
				lookupID = upstream
			}
			info := lookupCPAStaticModelInfo(lookupID, auth)
			if info == nil {
				info = &registry.ModelInfo{ID: model}
			} else {
				info.ID = model
			}
			if alias.image {
				info.Type = registry.OpenAIImageModelType
			}
			modelInfos = append(modelInfos, info)
		}
	}
	return auth, route, modelInfos, nil
}

func lookupCPAStaticModelInfo(modelID string, auth *coreauth.Auth) *registry.ModelInfo {
	for _, info := range cpaStaticModelsForAuth(auth.Provider, auth) {
		if info != nil && strings.EqualFold(strings.TrimSpace(info.ID), strings.TrimSpace(modelID)) {
			cloned := *info
			return &cloned
		}
	}
	return registry.LookupStaticModelInfo(modelID)
}

func applyCPAAuthModelMetadata(auth *coreauth.Auth, metadata map[string]any) {
	if auth == nil || metadata == nil {
		return
	}
	excluded := metadataStringSlice(metadata, "excluded_models", "excluded-models")
	if len(excluded) > 0 {
		normalized := make([]string, 0, len(excluded))
		for _, model := range excluded {
			if model = strings.ToLower(strings.TrimSpace(model)); model != "" {
				normalized = append(normalized, model)
			}
		}
		sort.Strings(normalized)
		auth.Attributes["excluded_models"] = strings.Join(normalized, ",")
	}
	rawAliases, ok := metadata["model_aliases"]
	if !ok {
		rawAliases = metadata["model-aliases"]
	}
	if rawAliases != nil {
		payload, marshalErr := json.Marshal(rawAliases)
		var aliases []internalconfig.OAuthModelAlias
		if marshalErr == nil && json.Unmarshal(payload, &aliases) == nil {
			cfg := internalconfig.Config{OAuthModelAlias: map[string][]internalconfig.OAuthModelAlias{"auth": aliases}}
			cfg.SanitizeOAuthModelAlias()
			coreauth.SetOAuthModelAliasesAttribute(auth, cfg.OAuthModelAlias["auth"])
		}
	}
}

func metadataStringSlice(metadata map[string]any, keys ...string) []string {
	for _, key := range keys {
		raw, ok := metadata[key]
		if !ok {
			continue
		}
		values, ok := raw.([]any)
		if !ok {
			if stringsValue, stringsOK := raw.([]string); stringsOK {
				return append([]string(nil), stringsValue...)
			}
			continue
		}
		result := make([]string, 0, len(values))
		for _, value := range values {
			if model, valueOK := value.(string); valueOK {
				result = append(result, model)
			}
		}
		return result
	}
	return nil
}

func filterExcludedModelIDs(models []string, auth *coreauth.Auth) []string {
	if auth == nil || strings.TrimSpace(auth.Attributes["excluded_models"]) == "" {
		return models
	}
	excluded := make(map[string]struct{})
	for _, model := range strings.Split(auth.Attributes["excluded_models"], ",") {
		excluded[strings.ToLower(strings.TrimSpace(model))] = struct{}{}
	}
	filtered := make([]string, 0, len(models))
	for _, model := range models {
		if _, skip := excluded[strings.ToLower(strings.TrimSpace(model))]; !skip {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func modelAliases(metadata map[string]any) map[string]modelRoute {
	result := make(map[string]modelRoute)
	items, _ := metadata["model_routes"].([]any)
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		public := stringValue(item, "public")
		upstream := stringValue(item, "upstream")
		image, _ := item["image"].(bool)
		if public != "" && upstream != "" {
			result[strings.ToLower(public)] = modelRoute{upstream: upstream, image: image}
		}
	}
	return result
}

func stringValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func normalizeProvider(provider string) string {
	switch value := strings.ToLower(strings.TrimSpace(provider)); value {
	case "grok":
		return "xai"
	case "anthropic":
		return "claude"
	case "openai-compatible":
		return "openai"
	case "interactions", "gemini-interactions-api-key":
		return "gemini-interactions"
	case "gemini-api-key":
		return "gemini"
	default:
		return value
	}
}

func (r *Runtime) pinCredentialMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request != nil {
			if id := strings.TrimSpace(c.GetHeader("X-Relay-CPA-Auth-ID")); id != "" {
				ctx := handlers.WithPinnedAuthID(c.Request.Context(), id)
				c.Request = c.Request.WithContext(ctx)
			}
		}
		c.Next()
	}
}

// HasModelRouters enables the request-scoped Relay route below.
func (r *Runtime) HasModelRouters() bool { return true }

// ResolveCredentialModel returns the provider-facing model name for a pinned
// credential without taking model routing away from CPA's WebSocket handler.
func (r *Runtime) ResolveCredentialModel(authID, requestedModel string) string {
	requestedModel = strings.TrimSpace(requestedModel)
	if r == nil || requestedModel == "" {
		return requestedModel
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	route, ok := r.routes[strings.TrimSpace(authID)]
	if !ok {
		route, ok = r.modelRoutes[strings.ToLower(requestedModel)]
	}
	if !ok {
		return requestedModel
	}
	for public, model := range route.models {
		if strings.EqualFold(public, requestedModel) && strings.TrimSpace(model.upstream) != "" {
			return strings.TrimSpace(model.upstream)
		}
	}
	return requestedModel
}

// RouteModel binds CPA execution to the provider selected by Relay admission
// and applies the per-credential public-to-upstream model alias.
func (r *Runtime) RouteModel(_ context.Context, request pluginapi.ModelRouteRequest) (pluginapi.ModelRouteResponse, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var route credentialRoute
	var ok bool
	if id := strings.TrimSpace(request.Headers.Get("X-Relay-CPA-Auth-ID")); id != "" {
		route, ok = r.routes[id]
	} else {
		route, ok = r.modelRoutes[strings.ToLower(strings.TrimSpace(request.RequestedModel))]
	}
	if !ok || route.provider == "" {
		return pluginapi.ModelRouteResponse{}, false
	}
	targetModel := strings.TrimSpace(request.RequestedModel)
	if strings.EqualFold(strings.TrimSpace(request.Headers.Get("Upgrade")), "websocket") {
		// Credential pinning is already enforced by middleware and the gateway
		// resolves the first frame's alias through ResolveCredentialModel.
		// Reporting any route override here makes every continuation look like a
		// transport change and forces an HTTP replay.
		return pluginapi.ModelRouteResponse{}, false
	}
	if alias, exists := route.models[targetModel]; exists && alias.upstream != "" {
		targetModel = alias.upstream
	} else {
		for public, model := range route.models {
			if strings.EqualFold(public, targetModel) {
				targetModel = model.upstream
				break
			}
		}
	}
	return pluginapi.ModelRouteResponse{
		Handled: true, TargetKind: pluginapi.ModelRouteTargetProvider,
		Target: route.provider, TargetModel: targetModel, Reason: "relay credential route",
	}, true
}

// Close releases retained CPA WebSocket sessions and model registrations.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.manager.StopAutoRefresh()
	r.mu.Lock()
	for id := range r.authIDs {
		registry.GetGlobalRegistry().UnregisterClient(id)
	}
	r.authIDs = map[string]struct{}{}
	r.routes = map[string]credentialRoute{}
	r.modelRoutes = map[string]credentialRoute{}
	r.modelNames = map[string]string{}
	r.mu.Unlock()
	for _, provider := range []string{"codex", "xai", "claude", "gemini", "gemini-interactions", "vertex", "aistudio", "antigravity", "kimi", "openai", "openai-compatibility"} {
		if exec, ok := r.manager.Executor(provider); ok {
			CloseAllExecutionSessions(exec)
		}
	}
	var stopErr error
	if r.wsGateway != nil {
		stopErr = r.wsGateway.Stop(ctx)
	}
	if r.oauthDir != "" {
		if err := os.RemoveAll(r.oauthDir); stopErr == nil {
			stopErr = err
		}
	}
	return stopErr
}
