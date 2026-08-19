package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func (a *App) startNativeRuntime(ctx context.Context) error {
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	settings, settingsFound, legacyProxy, boundsFilled, err := a.loadNativeRuntimeSettings(ctx)
	if err != nil {
		return fmt.Errorf("load native runtime settings: %w", err)
	}
	migrated, err := a.migrateLegacyProxies(ctx, rows, &settings, legacyProxy)
	if err != nil {
		return fmt.Errorf("migrate proxy configuration: %w", err)
	}
	if !settingsFound || migrated || legacyProxy != "" || boundsFilled {
		if err = a.store.PutRuntimeSetting(ctx, nativeRuntimeSettingsKey, settings); err != nil {
			return fmt.Errorf("initialize native runtime settings: %w", err)
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
	slog.Info("native runtime upstream websocket policy", "enabled", settings.UpstreamWebSockets, "eligible_credentials", webSocketCredentials)
	if message := validateNativeRuntimeSettings(settings); message != "" {
		return fmt.Errorf("stored native runtime settings are invalid: %s", message)
	}
	a.nativeSettings.value = settings
	runtime, err := upstream.NewRuntime(upstream.Options{
		RoutingStrategy: settings.RoutingStrategy,
		ProxyURL:        firstNonEmptyString(systemProxyURL, "direct"), FailureThreshold: settings.CredentialFailureThreshold,
		FailureCooldown:       time.Duration(settings.CredentialCooldownSeconds) * time.Second,
		ResponseHeaderTimeout: time.Duration(settings.RequestTimeoutSeconds) * time.Second,
		OnCredentialUpdated: func(updateCtx context.Context, id string, document []byte) {
			if persistErr := a.persistEmbeddedCredential(updateCtx, id, document); persistErr != nil {
				slog.Warn("persist native runtime credential refresh", "credential_id", id, "error", persistErr)
			}
		},
		OnOAuthCredential: a.captureProviderOAuthCredential,
	}, credentials)
	if err != nil {
		return fmt.Errorf("build native runtime: %w", err)
	}
	a.replaceAdmission(settings)
	a.nativeRuntime = runtime
	return nil
}

func runtimeCredentials(rows []store.UpstreamCredentialSnapshot, upstreamWebSockets bool, proxyURLs map[string]string) []upstream.Credential {
	now := time.Now()
	credentials := make([]upstream.Credential, 0, len(rows))
	for _, row := range rows {
		if !supportedStoredCredential(row.Provider, row.Document) {
			continue
		}
		enabled := row.Enabled && (row.ExpiresAt == nil || row.ExpiresAt.After(now))
		document := append([]byte(nil), row.Document...)
		var value map[string]any
		if json.Unmarshal(document, &value) == nil {
			value["proxy_url"] = "direct"
			if row.ProxyID != nil {
				if proxyURL := strings.TrimSpace(proxyURLs[*row.ProxyID]); proxyURL != "" {
					value["proxy_url"] = proxyURL
				}
			}
			delete(value, "_relay_proxy_url")
			provider := strings.ToLower(strings.TrimSpace(row.Provider))
			if provider == "codex" || provider == "xai" {
				value["websockets"] = upstreamWebSockets
			}
			if encoded, marshalErr := json.Marshal(value); marshalErr == nil {
				document = encoded
			}
		}
		credentials = append(credentials, upstream.Credential{ID: row.ID, Label: row.Name, Provider: row.Provider, Enabled: enabled, Models: append([]string(nil), row.Models...), Document: document})
	}
	return credentials
}

func (a *App) reloadNativeCredentials(ctx context.Context) error {
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	if a.nativeRuntime == nil {
		return fmt.Errorf("native runtime is not available")
	}
	proxyURLs, err := a.proxyURLs(ctx)
	if err != nil {
		return err
	}
	return a.nativeRuntime.ReplaceCredentials(ctx, runtimeCredentials(rows, a.upstreamWebSockets(), proxyURLs))
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
	document = stripCredentialProxyFields(document)
	_, err = a.store.UpsertUpstreamCredential(persistCtx, store.UpstreamCredentialInput{
		ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
		Models: row.Models, Document: document, Source: row.Source, ProxyID: row.ProxyID, ExpiresAt: row.ExpiresAt,
	})
	return err
}

func stripCredentialProxyFields(document []byte) []byte {
	var value map[string]any
	if json.Unmarshal(document, &value) != nil {
		return document
	}
	delete(value, "proxy_url")
	delete(value, "_relay_proxy_url")
	encoded, err := json.Marshal(value)
	if err != nil {
		return document
	}
	return encoded
}

func (a *App) admission() *gateway.Client {
	if a == nil {
		return nil
	}
	return a.nativeAdmission.Load()
}
