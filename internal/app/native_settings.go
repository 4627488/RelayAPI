package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

const nativeRuntimeSettingsKey = "native-runtime"

type nativeRuntimeSettings struct {
	RequestRetry          int    `json:"request_retry"`
	MaxRetryInterval      int    `json:"max_retry_interval"`
	RoutingStrategy       string `json:"routing_strategy"`
	SystemProxyID         string `json:"system_proxy_id"`
	PassthroughHeaders    bool   `json:"passthrough_headers"`
	CodexCapabilityPolicy string `json:"codex_capability_policy"`
	ForceModelPrefix      bool   `json:"force_model_prefix"`
}

type settingsState struct {
	sync.RWMutex
	value nativeRuntimeSettings
}

func defaultNativeRuntimeSettings() nativeRuntimeSettings {
	return nativeRuntimeSettings{
		RequestRetry: 2, MaxRetryInterval: 30,
		RoutingStrategy: "round-robin", PassthroughHeaders: true, CodexCapabilityPolicy: "optimistic",
	}
}

func (a *App) loadNativeRuntimeSettings(ctx context.Context) (nativeRuntimeSettings, bool, string, error) {
	settings := defaultNativeRuntimeSettings()
	var document json.RawMessage
	found, err := a.store.GetRuntimeSetting(ctx, nativeRuntimeSettingsKey, &document)
	if err != nil || !found {
		return settings, found, "", err
	}
	if err = json.Unmarshal(document, &settings); err != nil {
		return settings, true, "", err
	}
	var legacy struct {
		ProxyURL string `json:"proxy_url"`
	}
	_ = json.Unmarshal(document, &legacy)
	return settings, true, strings.TrimSpace(legacy.ProxyURL), nil
}

func validateNativeRuntimeSettings(value nativeRuntimeSettings) string {
	if value.RequestRetry < 0 || value.RequestRetry > 20 {
		return "请求重试次数必须在 0 到 20 之间"
	}
	if value.MaxRetryInterval < 0 || value.MaxRetryInterval > 3600 {
		return "最大重试间隔必须在 0 到 3600 秒之间"
	}
	if value.RoutingStrategy != "round-robin" && value.RoutingStrategy != "fill-first" {
		return "凭据调度策略无效"
	}
	if value.CodexCapabilityPolicy == "" {
		value.CodexCapabilityPolicy = "optimistic"
	}
	if value.CodexCapabilityPolicy != "optimistic" && value.CodexCapabilityPolicy != "verified" {
		return "Codex 能力策略必须是 optimistic 或 verified"
	}
	return ""
}

func runtimeSettings(value nativeRuntimeSettings, systemProxyURL string) upstream.Settings {
	if strings.TrimSpace(systemProxyURL) == "" {
		systemProxyURL = "direct"
	}
	return upstream.Settings{
		RequestRetry:     value.RequestRetry,
		MaxRetryInterval: time.Duration(value.MaxRetryInterval) * time.Second,
		RoutingStrategy:  value.RoutingStrategy, ProxyURL: systemProxyURL,
		PassthroughHeaders: value.PassthroughHeaders, ForceModelPrefix: value.ForceModelPrefix,
	}
}

func (a *App) adminNativeSettings(w http.ResponseWriter, r *http.Request) {
	if a.nativeRuntime == nil {
		writeError(w, http.StatusConflict, "native_mode_required", "此配置仅适用于 native 数据平面")
		return
	}
	if r.Method == http.MethodGet {
		a.nativeSettings.RLock()
		value := a.nativeSettings.value
		a.nativeSettings.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"mode": "native", "settings": value, "runtime": a.nativeRuntimeInfo()})
		return
	}
	var input nativeRuntimeSettings
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.CodexCapabilityPolicy) == "" {
		input.CodexCapabilityPolicy = "optimistic"
	}
	if message := validateNativeRuntimeSettings(input); message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	systemProxyURL := ""
	if input.SystemProxyID != "" {
		var err error
		systemProxyURL, err = a.proxyURL(r.Context(), input.SystemProxyID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusBadRequest, "proxy_not_found", "选择的系统代理不存在")
			} else {
				writeError(w, http.StatusInternalServerError, "proxy_unavailable", "无法读取系统代理")
			}
			return
		}
	}
	a.nativeSettings.RLock()
	previous := a.nativeSettings.value
	a.nativeSettings.RUnlock()
	if err := a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, input); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "运行配置持久化失败")
		return
	}
	if err := a.nativeRuntime.ApplySettings(r.Context(), runtimeSettings(input, systemProxyURL)); err != nil {
		_ = a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, previous)
		writeError(w, http.StatusInternalServerError, "runtime_update_failed", err.Error())
		return
	}
	a.nativeSettings.Lock()
	a.nativeSettings.value = input
	a.nativeSettings.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"mode": "native", "settings": input, "runtime": a.nativeRuntimeInfo()})
}

func (a *App) nativeRuntimeInfo() map[string]any {
	return map[string]any{
		"ready": a.nativeRuntime != nil, "credentials": a.nativeRuntime.CredentialCount(), "models": len(a.nativeRuntime.Models()),
		"request_timeout_seconds": int(a.cfg.RequestTimeout / time.Second), "max_in_flight": a.cfg.GatewayMaxInFlight,
		"max_queue": a.cfg.GatewayMaxQueue, "queue_timeout_seconds": int(a.cfg.GatewayQueueTimeout / time.Second),
		"max_request_bytes": a.cfg.MaxRequestBytes, "request_bytes_in_flight": a.cfg.RequestBytesInFlight,
		"circuit_failure_threshold": a.cfg.GatewayCircuitFailureThreshold, "circuit_open_seconds": int(a.cfg.GatewayCircuitOpenDuration / time.Second),
		"executor_cache_pressure_bytes": a.cfg.ExecutorCachePressureBytes, "unpriced_model_policy": a.cfg.UnpricedModelPolicy,
		"request_log_retention_days": a.cfg.RequestLogRetentionDays, "request_success_detail_days": a.cfg.RequestSuccessDetailDays,
		"request_error_detail_days": a.cfg.RequestDetailRetentionDays,
	}
}
