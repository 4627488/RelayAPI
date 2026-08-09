package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

func (a *App) startEmbeddedCPA(ctx context.Context) error {
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	credentials := bridgeCredentials(rows, a.cfg.UpstreamWebSockets)
	settings, settingsFound, err := a.loadNativeRuntimeSettings(ctx)
	if err != nil {
		return fmt.Errorf("load native runtime settings: %w", err)
	}
	if !settingsFound {
		settings.ProxyURL = importedGlobalProxy(rows)
		if err = a.store.PutRuntimeSetting(ctx, nativeRuntimeSettingsKey, settings); err != nil {
			return fmt.Errorf("initialize native runtime settings: %w", err)
		}
	}
	if message := validateNativeRuntimeSettings(settings); message != "" {
		return fmt.Errorf("stored native runtime settings are invalid: %s", message)
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
		ProxyURL: settings.ProxyURL, PassthroughHeaders: settings.PassthroughHeaders,
		DisableImageGeneration: runtimeBridgeSettings(settings).DisableImageGeneration,
		GPTImage2BaseModel:     settings.GPTImageBaseModel, VideoResultAuthCacheTTL: settings.VideoResultAuthCacheTTL,
		ForceModelPrefix: settings.ForceModelPrefix, StreamKeepAliveSeconds: settings.StreamKeepAliveSeconds,
		StreamBootstrapRetries: settings.StreamBootstrapRetries, NonStreamKeepAliveInterval: settings.NonStreamKeepAliveInterval,
		OnCredentialUpdated: func(updateCtx context.Context, id string, document []byte) {
			if persistErr := a.persistEmbeddedCredential(updateCtx, id, document); persistErr != nil {
				slog.Warn("persist embedded CPA credential refresh", "credential_id", id, "error", persistErr)
			}
		},
		OnOAuthCredential: a.captureProviderOAuthCredential,
	}, credentials)
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
	client, err := cpa.NewWithOptions("http://"+listener.Addr().String(), secret, "", cpa.Options{
		ResponseHeaderTimeout:   a.cfg.RequestTimeout,
		MaxInFlight:             a.cfg.CPAMaxInFlight,
		MaxQueue:                a.cfg.CPAMaxQueue,
		MaxRequestBytesInFlight: a.cfg.CPARequestBytesInFlight,
		QueueTimeout:            a.cfg.CPAQueueTimeout,
		CircuitFailureThreshold: a.cfg.CPACircuitFailureThreshold,
		CircuitOpenDuration:     a.cfg.CPACircuitOpenDuration,
	})
	if err != nil {
		_ = listener.Close()
		_ = runtime.Close(context.Background())
		return err
	}
	a.nativeCPA = client
	a.nativeCPARuntime = runtime
	a.nativeCPAServer = server
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			// The public server remains alive so health checks can expose the failure.
			a.nativeCPAServeErr.Store(serveErr)
		}
	}()
	return nil
}

func importedGlobalProxy(rows []store.UpstreamCredentialSnapshot) string {
	for _, row := range rows {
		var document map[string]any
		if json.Unmarshal(row.Document, &document) == nil {
			if value, _ := document["_relay_proxy_url"].(string); strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
}

func bridgeCredentials(rows []store.UpstreamCredentialSnapshot, upstreamWebSockets bool) []relaybridge.Credential {
	now := time.Now()
	credentials := make([]relaybridge.Credential, 0, len(rows))
	for _, row := range rows {
		enabled := row.Enabled && (row.ExpiresAt == nil || row.ExpiresAt.After(now))
		document := append([]byte(nil), row.Document...)
		provider := strings.ToLower(strings.TrimSpace(row.Provider))
		if !upstreamWebSockets && (provider == "codex" || provider == "xai") {
			var value map[string]any
			if json.Unmarshal(document, &value) == nil {
				value["websockets"] = false
				if encoded, marshalErr := json.Marshal(value); marshalErr == nil {
					document = encoded
				}
			}
		}
		credentials = append(credentials, relaybridge.Credential{ID: row.ID, Label: row.Name, Provider: row.Provider, Enabled: enabled, Models: append([]string(nil), row.Models...), Document: document})
	}
	return credentials
}

func (a *App) reloadNativeCredentials(ctx context.Context) error {
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	if a.nativeCPARuntime == nil {
		return fmt.Errorf("native CPA runtime is not available")
	}
	return a.nativeCPARuntime.ReplaceCredentials(ctx, bridgeCredentials(rows, a.cfg.UpstreamWebSockets))
}

func (a *App) persistEmbeddedCredential(ctx context.Context, id string, document []byte) error {
	if ctx == nil {
		ctx = context.Background()
	}
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	row, err := a.store.GetUpstreamCredential(persistCtx, id)
	if err != nil {
		return err
	}
	_, err = a.store.UpsertUpstreamCredential(persistCtx, store.UpstreamCredentialInput{
		ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
		Models: row.Models, Document: document, Source: row.Source, ExpiresAt: row.ExpiresAt,
	})
	return err
}

func (a *App) inferenceCPA() *cpa.Client {
	if a != nil && a.nativeCPA != nil {
		return a.nativeCPA
	}
	return nil
}
