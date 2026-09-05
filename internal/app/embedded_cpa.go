package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

func (a *App) startEmbeddedCPA(ctx context.Context, importedProxy string) error {
	if err := a.migrateEmbeddedCPAData(ctx); err != nil {
		return err
	}
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	settings, settingsFound, legacyProxy, boundsFilled, err := a.loadNativeRuntimeSettings(ctx)
	if err != nil {
		return fmt.Errorf("load embedded CPA settings: %w", err)
	}
	if legacyProxy == "" && !settingsFound {
		legacyProxy = strings.TrimSpace(importedProxy)
	}
	migrated, err := a.migrateLegacyProxies(ctx, rows, &settings, legacyProxy)
	if err != nil {
		return fmt.Errorf("migrate proxy configuration: %w", err)
	}
	if !settingsFound || migrated || legacyProxy != "" || boundsFilled {
		if err = a.store.PutRuntimeSetting(ctx, nativeRuntimeSettingsKey, settings); err != nil {
			return fmt.Errorf("initialize embedded CPA settings: %w", err)
		}
	}
	systemProxyURL := ""
	if settings.SystemProxyID != "" {
		if systemProxyURL, err = a.proxyURL(ctx, settings.SystemProxyID); err != nil {
			return fmt.Errorf("load selected system proxy: %w", err)
		}
	}
	rows, err = a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	proxyURLs, err := a.proxyURLs(ctx)
	if err != nil {
		return err
	}
	credentials := runtimeCredentials(rows, settings.UpstreamWebSockets, proxyURLs)
	webSocketCredentials := 0
	for _, credential := range credentials {
		provider := strings.ToLower(strings.TrimSpace(credential.Provider))
		if credential.Enabled && (provider == "codex" || provider == "xai") {
			webSocketCredentials++
		}
	}
	slog.Info("embedded CPA upstream websocket policy", "enabled", settings.UpstreamWebSockets, "eligible_credentials", webSocketCredentials)
	if message := validateNativeRuntimeSettings(settings); message != "" {
		return fmt.Errorf("stored embedded CPA settings are invalid: %s", message)
	}
	a.nativeSettings.value = settings
	secretBytes := make([]byte, 32)
	if _, err = rand.Read(secretBytes); err != nil {
		return fmt.Errorf("generate embedded CPA key: %w", err)
	}
	secret := hex.EncodeToString(secretBytes)
	runtime, err := relaybridge.NewRuntime(relaybridge.Options{
		APIKey: secret, RequestRetry: settings.RequestRetry, MaxRetryCredentials: settings.MaxRetryCredentials,
		MaxRetryInterval: time.Duration(settings.MaxRetryInterval) * time.Second, RoutingStrategy: settings.RoutingStrategy,
		ProxyURL: firstNonEmptyString(systemProxyURL, "direct"), PassthroughHeaders: settings.PassthroughHeaders,
		DisableImageGeneration: runtimeBridgeSettings(settings, systemProxyURL).DisableImageGeneration,
		GPTImage2BaseModel:     settings.GPTImageBaseModel, VideoResultAuthCacheTTL: settings.VideoResultAuthCacheTTL,
		ForceModelPrefix: settings.ForceModelPrefix, StreamKeepAliveSeconds: settings.StreamKeepAliveSeconds,
		StreamBootstrapRetries: settings.StreamBootstrapRetries, NonStreamKeepAliveInterval: settings.NonStreamKeepAliveInterval,
		DisableCredentialCooling: settings.DisableCredentialCooling,
		OnCredentialUpdated: func(updateCtx context.Context, id string, document []byte) {
			if persistErr := a.persistEmbeddedCredential(updateCtx, id, document); persistErr != nil {
				slog.Warn("persist embedded CPA credential refresh", "credential_id", id, "error", persistErr)
			}
		},
		OnOAuthCredential: a.captureProviderOAuthCredential,
	}, toBridgeCredentials(credentials))
	if err != nil {
		return fmt.Errorf("build embedded CPA runtime: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = runtime.Close(context.Background())
		return fmt.Errorf("listen for embedded CPA: %w", err)
	}
	server := &http.Server{
		Handler:           runtime.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	client, err := cpa.NewWithOptions("http://"+listener.Addr().String(), secret, cpa.Options{
		ResponseHeaderTimeout:   a.requestTimeout(),
		MaxInFlight:             a.cfg.GatewayMaxInFlight,
		MaxQueue:                a.cfg.GatewayMaxQueue,
		MaxRequestBytesInFlight: a.requestBytesInFlight(),
		QueueTimeout:            a.cfg.GatewayQueueTimeout,
		CircuitFailureThreshold: a.cfg.GatewayCircuitFailureThreshold,
		CircuitOpenDuration:     a.cfg.GatewayCircuitOpenDuration,
	})
	if err != nil {
		_ = listener.Close()
		_ = runtime.Close(context.Background())
		return err
	}
	a.replaceAdmission(settings)
	a.nativeCPA = client
	a.nativeCPARuntime = runtime
	a.nativeCPAServer = server
	a.nativeRuntime = &embeddedCPAAdapter{app: a}
	if err = a.persistExpandedCodexCredentialModels(ctx); err != nil {
		slog.Warn("persist expanded Codex credential models", "error", err)
	}
	if _, err = a.syncNativeParentSubscriptionRows(ctx); err != nil {
		_ = listener.Close()
		_ = runtime.Close(context.Background())
		return fmt.Errorf("synchronize native parent subscriptions after Codex catalog expand: %w", err)
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			a.nativeCPAServeErr.Store(serveErr)
		}
	}()
	return nil
}

func (a *App) persistExpandedCodexCredentialModels(ctx context.Context) error {
	if a == nil || a.nativeRuntime == nil || a.store.DB == nil {
		return nil
	}
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !strings.EqualFold(strings.TrimSpace(row.Provider), "codex") {
			continue
		}
		live := a.nativeRuntime.CredentialModels(row.ID)
		if len(live) == 0 || sameModelSet(live, row.Models) {
			continue
		}
		if _, err = a.store.UpsertUpstreamCredential(ctx, store.UpstreamCredentialInput{
			ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
			Models: live, Document: row.Document, Source: row.Source, ProxyID: row.ProxyID, ExpiresAt: row.ExpiresAt,
		}); err != nil {
			return fmt.Errorf("persist Codex models for %s: %w", row.ID, err)
		}
	}
	return nil
}

func sameModelSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, model := range left {
		counts[strings.ToLower(strings.TrimSpace(model))]++
	}
	for _, model := range right {
		key := strings.ToLower(strings.TrimSpace(model))
		if counts[key] == 0 {
			return false
		}
		counts[key]--
	}
	return true
}

func (a *App) migrateEmbeddedCPAData(ctx context.Context) error {
	if a == nil || a.store.DB == nil {
		return nil
	}
	if err := a.store.DB.WithContext(ctx).Exec(`
		UPDATE parent_subscriptions
		SET upstream_auth_index = upstream_credential_id
		WHERE COALESCE(upstream_auth_index, '') = ''
		  AND COALESCE(upstream_credential_id, '') <> ''
	`).Error; err != nil {
		return fmt.Errorf("backfill parent subscription auth index: %w", err)
	}
	return nil
}

func toBridgeCredentials(rows []upstream.Credential) []relaybridge.Credential {
	credentials := make([]relaybridge.Credential, 0, len(rows))
	for _, row := range rows {
		credentials = append(credentials, relaybridge.Credential{
			ID: row.ID, Label: row.Label, Provider: row.Provider, Enabled: row.Enabled,
			Models: append([]string(nil), row.Models...), Document: append([]byte(nil), row.Document...),
		})
	}
	return credentials
}

func (a *App) inferenceCPA() *cpa.Client {
	if a != nil && a.nativeCPA != nil {
		return a.nativeCPA
	}
	return nil
}

func (a *App) closeEmbeddedCPA() {
	if a == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if a.nativeCPAServer != nil {
		_ = a.nativeCPAServer.Shutdown(ctx)
	}
	if a.nativeCPARuntime != nil {
		_ = a.nativeCPARuntime.Close(context.Background())
	}
	a.nativeCPA = nil
	a.nativeCPARuntime = nil
	a.nativeCPAServer = nil
	a.nativeRuntime = nil
}

type embeddedCPAAdapter struct {
	app *App
}

func (e *embeddedCPAAdapter) runtime() *relaybridge.Runtime {
	if e == nil || e.app == nil {
		return nil
	}
	return e.app.nativeCPARuntime
}

func (e *embeddedCPAAdapter) Handler() http.Handler {
	if runtime := e.runtime(); runtime != nil {
		return runtime.Handler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "embedded CPA is not available", http.StatusServiceUnavailable)
	})
}

func (e *embeddedCPAAdapter) Serve(w http.ResponseWriter, r *http.Request, body []byte) {
	e.app.proxyEmbeddedCPA(w, r, body, false)
}

func (e *embeddedCPAAdapter) ServeModels(w http.ResponseWriter, r *http.Request) {
	e.app.proxyEmbeddedCPA(w, r, nil, true)
}

func (e *embeddedCPAAdapter) CredentialCount() int {
	if runtime := e.runtime(); runtime != nil {
		return runtime.CredentialCount()
	}
	return 0
}

func (e *embeddedCPAAdapter) Models() []string {
	if runtime := e.runtime(); runtime != nil {
		return runtime.Models()
	}
	return nil
}

func (e *embeddedCPAAdapter) ModelProvider(string) (string, bool) {
	return "", false
}

func (e *embeddedCPAAdapter) CredentialModels(id string) []string {
	if runtime := e.runtime(); runtime != nil {
		return runtime.CredentialModels(id)
	}
	return nil
}

func (e *embeddedCPAAdapter) CredentialStatus(id string) (upstream.CredentialStatus, bool) {
	runtime := e.runtime()
	if runtime == nil {
		return upstream.CredentialStatus{}, false
	}
	status, ok := runtime.CredentialStatus(id)
	if !ok {
		return upstream.CredentialStatus{}, false
	}
	return upstream.CredentialStatus{
		Status: status.Status, StatusMessage: status.StatusMessage, Unavailable: status.Unavailable,
		Success: status.Success, Failed: status.Failed, PlanType: status.PlanType,
		LastRefreshedAt: status.LastRefreshedAt, NextRetryAfter: status.NextRetryAfter,
		QuotaExceeded: status.QuotaExceeded, QuotaReason: status.QuotaReason, QuotaRecoverAt: status.QuotaRecoverAt,
	}, true
}

func (e *embeddedCPAAdapter) DiscoverCredentialModels(ctx context.Context, id string) ([]string, string, error) {
	if runtime := e.runtime(); runtime != nil {
		return runtime.DiscoverCredentialModels(ctx, id)
	}
	return nil, "", fmt.Errorf("embedded CPA runtime is not available")
}

func (e *embeddedCPAAdapter) ReplaceCredentials(ctx context.Context, credentials []upstream.Credential) error {
	if runtime := e.runtime(); runtime != nil {
		return runtime.ReplaceCredentials(ctx, toBridgeCredentials(credentials))
	}
	return fmt.Errorf("embedded CPA runtime is not available")
}

func (e *embeddedCPAAdapter) ApplySettings(ctx context.Context, settings upstream.Settings) error {
	if e == nil || e.app == nil || e.app.nativeCPARuntime == nil {
		return fmt.Errorf("embedded CPA runtime is not available")
	}
	current := e.app.currentNativeSettings()
	current.RoutingStrategy = settings.RoutingStrategy
	return e.app.nativeCPARuntime.ApplySettings(ctx, runtimeBridgeSettings(current, settings.ProxyURL))
}

func (e *embeddedCPAAdapter) ResolveCredentialModel(authID, requestedModel string) string {
	if runtime := e.runtime(); runtime != nil {
		return runtime.ResolveCredentialModel(authID, requestedModel)
	}
	return requestedModel
}

func (e *embeddedCPAAdapter) StartOAuth(ctx context.Context, provider, sessionID string) (upstream.OAuthStartResult, error) {
	runtime := e.runtime()
	if runtime == nil {
		return upstream.OAuthStartResult{}, fmt.Errorf("embedded CPA runtime is not available")
	}
	result, err := runtime.StartOAuth(ctx, provider, sessionID)
	if err != nil {
		return upstream.OAuthStartResult{}, err
	}
	return upstream.OAuthStartResult{
		Status: result.Status, URL: result.URL, State: result.State,
		Flow: result.Flow, UserCode: result.UserCode, ExpiresIn: result.ExpiresIn,
	}, nil
}

func (e *embeddedCPAAdapter) OAuthStatus(ctx context.Context, state string) (upstream.OAuthStatusResult, error) {
	runtime := e.runtime()
	if runtime == nil {
		return upstream.OAuthStatusResult{}, fmt.Errorf("embedded CPA runtime is not available")
	}
	result, err := runtime.OAuthStatus(ctx, state)
	if err != nil {
		return upstream.OAuthStatusResult{}, err
	}
	return upstream.OAuthStatusResult{Status: result.Status, Error: result.Error}, nil
}

func (e *embeddedCPAAdapter) SubmitOAuthCallback(ctx context.Context, provider, state, redirectURL string) error {
	if runtime := e.runtime(); runtime != nil {
		return runtime.SubmitOAuthCallback(ctx, provider, state, redirectURL)
	}
	return fmt.Errorf("embedded CPA runtime is not available")
}

func (e *embeddedCPAAdapter) CancelOAuth(ctx context.Context, state string) error {
	if runtime := e.runtime(); runtime != nil {
		return runtime.CancelOAuth(ctx, state)
	}
	return nil
}

func (e *embeddedCPAAdapter) RefreshCredential(context.Context, string, bool) ([]byte, bool, error) {
	return nil, false, nil
}

func (e *embeddedCPAAdapter) TakeRequestTrace(requestID string) (upstream.RequestTrace, bool) {
	runtime := e.runtime()
	if runtime == nil {
		return upstream.RequestTrace{}, false
	}
	trace, ok := runtime.TakeRequestTrace(requestID)
	if !ok {
		return upstream.RequestTrace{}, false
	}
	return convertCPATrace(trace), true
}

func (e *embeddedCPAAdapter) Close(ctx context.Context) error {
	if runtime := e.runtime(); runtime != nil {
		return runtime.Close(ctx)
	}
	return nil
}

func convertCPATrace(trace relaybridge.RequestTrace) upstream.RequestTrace {
	out := upstream.RequestTrace{RequestID: trace.RequestID, StartedAt: trace.StartedAt, CompletedAt: trace.CompletedAt}
	for _, attempt := range trace.Attempts {
		out.Attempts = append(out.Attempts, upstream.ExecutionAttempt{
			Number: attempt.Number, StartedAt: attempt.StartedAt, CompletedAt: attempt.CompletedAt,
			HeadersAt: attempt.HeadersAt, RequestWrittenAt: attempt.RequestWrittenAt,
			FirstResponseAt: firstNonZeroTime(attempt.FirstResponseAt, attempt.FirstChunkAt),
			GetConnAt:       attempt.GetConnAt, GotConnAt: attempt.GotConnAt,
			DNSStartedAt: attempt.DNSStartedAt, DNSCompletedAt: attempt.DNSCompletedAt,
			ConnectStartedAt: attempt.ConnectStartedAt, ConnectCompletedAt: attempt.ConnectCompletedAt,
			TLSStartedAt: attempt.TLSStartedAt, TLSCompletedAt: attempt.TLSCompletedAt,
			Status: attempt.Status, Error: attempt.Error, Provider: attempt.Provider,
			Model: attempt.Model, CredentialID: attempt.CredentialID,
			ConnectionReused: attempt.ConnectionReused, RemoteAddr: attempt.RemoteAddr,
		})
	}
	return out
}

func (a *App) proxyEmbeddedCPA(w http.ResponseWriter, r *http.Request, body []byte, control bool) {
	client := a.inferenceCPA()
	if client == nil || r == nil {
		http.Error(w, "embedded CPA is not available", http.StatusServiceUnavailable)
		return
	}
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, client.URL(r.URL.RequestURI()), reader)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copyHeaders(request.Header, r.Header)
	request.Header.Set("Authorization", "Bearer "+client.APIKey)
	request.Header.Del("X-API-Key")
	request.Header.Del("X-Goog-API-Key")
	if cred := strings.TrimSpace(r.Header.Get("X-Relay-Upstream-Credential-ID")); cred != "" {
		request.Header.Set("X-Relay-CPA-Auth-ID", cred)
	}
	if requestID := strings.TrimSpace(r.Header.Get("X-Relay-Request-ID")); requestID != "" {
		request.Header.Set("X-Relay-Request-ID", requestID)
	}
	request.Host = client.BaseURL.Host
	transport := client.HTTP
	if control && client.ControlHTTP != nil {
		transport = client.ControlHTTP
	}
	response, err := transport.Do(request)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	copyHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	buf := make([]byte, 32<<10)
	flusher, _ := w.(http.Flusher)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}
