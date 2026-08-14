package upstream

import (
	"context"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

// NewCompatibilityRuntime is the only production location allowed to depend
// on CPA's embedded bridge. The adapter is intentionally boring: semantic
// changes belong in Relay's runtime contract or a provider implementation,
// never in type assertions against CPA internals.
func NewCompatibilityRuntime(options Options, credentials []Credential) (Runtime, error) {
	runtime, err := relaybridge.NewRuntime(toCPAOptions(options), toCPACredentials(credentials))
	if err != nil {
		return nil, err
	}
	return &compatibilityRuntime{runtime: runtime}, nil
}

type compatibilityRuntime struct {
	runtime *relaybridge.Runtime
}

func (r *compatibilityRuntime) Handler() http.Handler { return r.runtime.Handler() }

func (r *compatibilityRuntime) CredentialCount() int { return r.runtime.CredentialCount() }
func (r *compatibilityRuntime) Models() []string     { return r.runtime.Models() }
func (r *compatibilityRuntime) ModelProvider(model string) (string, bool) {
	return r.runtime.ModelProvider(model)
}
func (r *compatibilityRuntime) CredentialModels(id string) []string {
	return r.runtime.CredentialModels(id)
}
func (r *compatibilityRuntime) CredentialStatus(id string) (CredentialStatus, bool) {
	status, ok := r.runtime.CredentialStatus(id)
	return CredentialStatus{
		Status: status.Status, StatusMessage: status.StatusMessage, Unavailable: status.Unavailable,
		Success: status.Success, Failed: status.Failed, PlanType: status.PlanType,
		LastRefreshedAt: status.LastRefreshedAt, NextRetryAfter: status.NextRetryAfter,
		QuotaExceeded: status.QuotaExceeded, QuotaReason: status.QuotaReason, QuotaRecoverAt: status.QuotaRecoverAt,
	}, ok
}
func (r *compatibilityRuntime) DiscoverCredentialModels(ctx context.Context, id string) ([]string, string, error) {
	return r.runtime.DiscoverCredentialModels(ctx, id)
}
func (r *compatibilityRuntime) ReplaceCredentials(ctx context.Context, credentials []Credential) error {
	return r.runtime.ReplaceCredentials(ctx, toCPACredentials(credentials))
}
func (r *compatibilityRuntime) ApplySettings(ctx context.Context, settings Settings) error {
	return r.runtime.ApplySettings(ctx, relaybridge.Settings{
		RequestRetry: settings.RequestRetry, MaxRetryCredentials: settings.MaxRetryCredentials,
		MaxRetryInterval: settings.MaxRetryInterval, RoutingStrategy: settings.RoutingStrategy,
		ProxyURL: settings.ProxyURL, PassthroughHeaders: settings.PassthroughHeaders,
		DisableImageGeneration: settings.DisableImageGeneration, GPTImage2BaseModel: settings.GPTImage2BaseModel,
		VideoResultAuthCacheTTL: settings.VideoResultAuthCacheTTL, ForceModelPrefix: settings.ForceModelPrefix,
		StreamKeepAliveSeconds: settings.StreamKeepAliveSeconds, StreamBootstrapRetries: settings.StreamBootstrapRetries,
		NonStreamKeepAliveInterval: settings.NonStreamKeepAliveInterval,
	})
}
func (r *compatibilityRuntime) ResolveCredentialModel(id, model string) string {
	return r.runtime.ResolveCredentialModel(id, model)
}
func (r *compatibilityRuntime) StartOAuth(ctx context.Context, provider, sessionID string) (OAuthStartResult, error) {
	result, err := r.runtime.StartOAuth(ctx, provider, sessionID)
	return OAuthStartResult{Status: result.Status, URL: result.URL, State: result.State, Flow: result.Flow, UserCode: result.UserCode, ExpiresIn: result.ExpiresIn}, err
}
func (r *compatibilityRuntime) OAuthStatus(ctx context.Context, state string) (OAuthStatusResult, error) {
	result, err := r.runtime.OAuthStatus(ctx, state)
	return OAuthStatusResult{Status: result.Status, Error: result.Error}, err
}
func (r *compatibilityRuntime) SubmitOAuthCallback(ctx context.Context, provider, state, redirectURL string) error {
	return r.runtime.SubmitOAuthCallback(ctx, provider, state, redirectURL)
}
func (r *compatibilityRuntime) CancelOAuth(ctx context.Context, state string) error {
	return r.runtime.CancelOAuth(ctx, state)
}
func (r *compatibilityRuntime) Close(ctx context.Context) error { return r.runtime.Close(ctx) }

func toCPACredentials(credentials []Credential) []relaybridge.Credential {
	result := make([]relaybridge.Credential, 0, len(credentials))
	for _, credential := range credentials {
		result = append(result, relaybridge.Credential{
			ID: credential.ID, Label: credential.Label, Provider: credential.Provider,
			Enabled: credential.Enabled, Models: append([]string(nil), credential.Models...),
			Document: append([]byte(nil), credential.Document...),
		})
	}
	return result
}

func toCPAOptions(options Options) relaybridge.Options {
	return relaybridge.Options{
		APIKey: options.APIKey, RequestRetry: options.RequestRetry, MaxRetryCredentials: options.MaxRetryCredentials,
		MaxRetryInterval: options.MaxRetryInterval, RoutingStrategy: options.RoutingStrategy,
		ProxyURL: options.ProxyURL, PassthroughHeaders: options.PassthroughHeaders,
		DisableImageGeneration: options.DisableImageGeneration, GPTImage2BaseModel: options.GPTImage2BaseModel,
		VideoResultAuthCacheTTL: options.VideoResultAuthCacheTTL, ForceModelPrefix: options.ForceModelPrefix,
		StreamKeepAliveSeconds: options.StreamKeepAliveSeconds, StreamBootstrapRetries: options.StreamBootstrapRetries,
		NonStreamKeepAliveInterval: options.NonStreamKeepAliveInterval,
		OnCredentialUpdated:        options.OnCredentialUpdated, OnOAuthCredential: options.OnOAuthCredential,
	}
}

var _ Runtime = (*compatibilityRuntime)(nil)

// ClearCompatibilityCaches is temporary compatibility cleanup while the
// provider implementations are migrated. Keeping it here prevents CPA cache
// packages from leaking back into the application layer.
func ClearCompatibilityCaches() {
	relaybridge.ClearReasoningCaches()
}
