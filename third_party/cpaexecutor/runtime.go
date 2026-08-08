package relaybridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/api"
	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/wsrelay"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v7/sdk/access"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

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
	OnCredentialUpdated        func(context.Context, string, []byte)
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
}

// Runtime owns CPA's complete public inference router and provider runtime.
// It intentionally does not enable CPA's management surface.
type Runtime struct {
	mu          sync.RWMutex
	cfg         *internalconfig.Config
	manager     *coreauth.Manager
	handler     http.Handler
	server      *api.Server
	wsGateway   *wsrelay.Manager
	routes      map[string]credentialRoute
	modelRoutes map[string]credentialRoute
	modelNames  map[string]string
	authIDs     map[string]struct{}
	credentials []Credential
	globalProxy string
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
		CommercialMode:      true,
		WebsocketAuth:       true,
		RequestRetry:        opts.RequestRetry,
		MaxRetryCredentials: opts.MaxRetryCredentials,
		MaxRetryInterval:    maxRetryInterval,
	}
	cfg.DisableImageGeneration = imageGenerationMode(opts.DisableImageGeneration)
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, runtimeAuthHook{updated: opts.OnCredentialUpdated})
	if opts.RoutingStrategy == "fill-first" {
		manager.SetSelector(&coreauth.FillFirstSelector{})
	}
	manager.SetRetryConfig(opts.RequestRetry, opts.MaxRetryInterval, opts.MaxRetryCredentials)
	accessManager := sdkaccess.NewManager()
	runtime := &Runtime{
		cfg: cfg, manager: manager, routes: make(map[string]credentialRoute),
		modelRoutes: make(map[string]credentialRoute), modelNames: make(map[string]string), authIDs: make(map[string]struct{}), globalProxy: strings.TrimSpace(opts.ProxyURL),
	}
	runtime.wsGateway = wsrelay.NewManager(wsrelay.Options{Path: "/v1/ws"})
	runtime.registerBaselineExecutors()

	var engine *gin.Engine
	server := api.NewServer(cfg, manager, accessManager, "",
		api.WithMiddleware(runtime.pinCredentialMiddleware()),
		api.WithEngineConfigurator(func(value *gin.Engine) { engine = value }),
		api.WithRouterConfigurator(func(_ *gin.Engine, base *handlers.BaseAPIHandler, _ *internalconfig.Config) {
			base.SetModelRouterHost(runtime)
		}),
	)
	if engine == nil {
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
		r.manager.RegisterExecutor(exec)
	}
}

// Handler returns CPA's public inference HTTP handler.
func (r *Runtime) Handler() http.Handler { return r.handler }

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
	for id := range r.authIDs {
		r.manager.Remove(ctx, id)
		registry.GetGlobalRegistry().UnregisterClient(id)
	}
	r.routes = make(map[string]credentialRoute, len(compiled))
	r.modelRoutes = make(map[string]credentialRoute)
	r.modelNames = make(map[string]string)
	r.authIDs = make(map[string]struct{}, len(compiled))
	r.credentials = append([]Credential(nil), credentials...)
	for _, item := range compiled {
		provider := item.route.provider
		r.ensureExecutor(provider)
		if _, err := r.manager.Register(ctx, item.auth); err != nil {
			return fmt.Errorf("register CPA credential %q: %w", item.auth.ID, err)
		}
		r.authIDs[item.auth.ID] = struct{}{}
		r.routes[item.auth.ID] = item.route
		for public := range item.route.models {
			key := strings.ToLower(public)
			r.modelRoutes[key] = item.route
			r.modelNames[key] = public
		}
		registry.GetGlobalRegistry().RegisterClient(item.auth.ID, provider, item.models)
	}
	return nil
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
	r.globalProxy = strings.TrimSpace(settings.ProxyURL)
	credentials := append([]Credential(nil), r.credentials...)
	r.mu.Unlock()
	if settings.RoutingStrategy == "fill-first" {
		r.manager.SetSelector(&coreauth.FillFirstSelector{})
	} else {
		r.manager.SetSelector(&coreauth.RoundRobinSelector{})
	}
	r.manager.SetRetryConfig(settings.RequestRetry, settings.MaxRetryInterval, settings.MaxRetryCredentials)
	return r.ReplaceCredentials(ctx, credentials)
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
	r.manager.RegisterExecutor(executor.NewOpenAICompatExecutor(provider, r.cfg))
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
	provider := normalizeProvider(item.Provider)
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
	} {
		if value, ok := metadata[key].(string); ok && strings.TrimSpace(value) != "" {
			attrs[key] = strings.TrimSpace(value)
		}
	}
	if provider == "openai" || provider == "openai-compatibility" {
		attrs["compat_name"] = provider
		attrs["provider_key"] = provider
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
	coreauth.ApplyCustomHeadersFromMetadata(auth)
	if err := coreauth.ValidateAuthWeight(auth); err != nil {
		return nil, credentialRoute{}, nil, fmt.Errorf("CPA credential %q has invalid weight: %w", id, err)
	}

	aliases := modelAliases(metadata)
	route := credentialRoute{provider: provider, models: make(map[string]modelRoute)}
	modelInfos := make([]*registry.ModelInfo, 0, len(item.Models)*2)
	seen := make(map[string]struct{})
	for _, public := range item.Models {
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
			info := &registry.ModelInfo{ID: model}
			if alias.image {
				info.Type = registry.OpenAIImageModelType
			}
			modelInfos = append(modelInfos, info)
		}
	}
	return auth, route, modelInfos, nil
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
	if r.wsGateway != nil {
		return r.wsGateway.Stop(ctx)
	}
	return nil
}
