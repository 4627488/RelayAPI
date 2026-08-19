package upstream

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
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

// NewRuntime creates the focused Relay runtime for Codex, Kimi, xAI,
// Aliyun Bailian and OpenAI-compatible providers.
func NewRuntime(options Options, credentials []Credential) (Runtime, error) {
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
		RoutingStrategy: options.RoutingStrategy,
		ProxyURL:        options.ProxyURL, FailureThreshold: options.FailureThreshold,
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

var _ Runtime = (*nativeRuntime)(nil)
