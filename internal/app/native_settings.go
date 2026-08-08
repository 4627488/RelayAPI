package app

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

const nativeRuntimeSettingsKey = "native-runtime"

type nativeRuntimeSettings struct {
	RequestRetry               int    `json:"request_retry"`
	MaxRetryCredentials        int    `json:"max_retry_credentials"`
	MaxRetryInterval           int    `json:"max_retry_interval"`
	RoutingStrategy            string `json:"routing_strategy"`
	ProxyURL                   string `json:"proxy_url"`
	PassthroughHeaders         bool   `json:"passthrough_headers"`
	ImageGenerationMode        string `json:"image_generation_mode"`
	GPTImageBaseModel          string `json:"gpt_image_base_model"`
	VideoResultAuthCacheTTL    string `json:"video_result_auth_cache_ttl"`
	ForceModelPrefix           bool   `json:"force_model_prefix"`
	StreamKeepAliveSeconds     int    `json:"stream_keepalive_seconds"`
	StreamBootstrapRetries     int    `json:"stream_bootstrap_retries"`
	NonStreamKeepAliveInterval int    `json:"nonstream_keepalive_interval"`
}

type settingsState struct {
	sync.RWMutex
	value nativeRuntimeSettings
}

func defaultNativeRuntimeSettings() nativeRuntimeSettings {
	return nativeRuntimeSettings{
		RequestRetry: 2, MaxRetryCredentials: 0, MaxRetryInterval: 30,
		RoutingStrategy: "round-robin", PassthroughHeaders: true,
		ImageGenerationMode: "enabled", GPTImageBaseModel: "gpt-5.4-mini",
		VideoResultAuthCacheTTL: "3h", StreamKeepAliveSeconds: 15,
		StreamBootstrapRetries: 1,
	}
}

func (a *App) loadNativeRuntimeSettings(ctx context.Context) (nativeRuntimeSettings, bool, error) {
	settings := defaultNativeRuntimeSettings()
	found, err := a.store.GetRuntimeSetting(ctx, nativeRuntimeSettingsKey, &settings)
	return settings, found, err
}

func validateNativeRuntimeSettings(value nativeRuntimeSettings) string {
	if value.RequestRetry < 0 || value.RequestRetry > 20 {
		return "请求重试次数必须在 0 到 20 之间"
	}
	if value.MaxRetryCredentials < 0 || value.MaxRetryCredentials > 100 {
		return "最大凭据尝试数必须在 0 到 100 之间"
	}
	if value.MaxRetryInterval < 0 || value.MaxRetryInterval > 3600 {
		return "最大重试间隔必须在 0 到 3600 秒之间"
	}
	if value.RoutingStrategy != "round-robin" && value.RoutingStrategy != "fill-first" {
		return "凭据调度策略无效"
	}
	if value.StreamKeepAliveSeconds < 0 || value.StreamKeepAliveSeconds > 300 || value.NonStreamKeepAliveInterval < 0 || value.NonStreamKeepAliveInterval > 300 {
		return "保活间隔必须在 0 到 300 秒之间"
	}
	if value.StreamBootstrapRetries < 0 || value.StreamBootstrapRetries > 10 {
		return "流式启动重试必须在 0 到 10 之间"
	}
	switch value.ImageGenerationMode {
	case "enabled", "disabled", "chat", "passthrough":
	default:
		return "图像生成策略无效"
	}
	if value.GPTImageBaseModel != "" && !strings.HasPrefix(strings.ToLower(value.GPTImageBaseModel), "gpt-") {
		return "图像基础模型必须以 gpt- 开头"
	}
	if value.VideoResultAuthCacheTTL != "" {
		if duration, err := time.ParseDuration(value.VideoResultAuthCacheTTL); err != nil || duration <= 0 {
			return "视频结果绑定时长必须是有效的正数 duration，例如 3h"
		}
	}
	proxy := strings.TrimSpace(value.ProxyURL)
	if proxy != "" && proxy != "direct" && proxy != "none" {
		parsed, err := url.Parse(proxy)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "socks5" && parsed.Scheme != "socks5h") {
			return "代理地址格式无效"
		}
	}
	return ""
}

func runtimeBridgeSettings(value nativeRuntimeSettings) relaybridge.Settings {
	imageMode := value.ImageGenerationMode
	if imageMode == "disabled" {
		imageMode = "all"
	}
	return relaybridge.Settings{
		RequestRetry: value.RequestRetry, MaxRetryCredentials: value.MaxRetryCredentials,
		MaxRetryInterval: time.Duration(value.MaxRetryInterval) * time.Second,
		RoutingStrategy:  value.RoutingStrategy, ProxyURL: value.ProxyURL,
		PassthroughHeaders: value.PassthroughHeaders, DisableImageGeneration: imageMode,
		GPTImage2BaseModel: value.GPTImageBaseModel, VideoResultAuthCacheTTL: value.VideoResultAuthCacheTTL,
		ForceModelPrefix: value.ForceModelPrefix, StreamKeepAliveSeconds: value.StreamKeepAliveSeconds,
		StreamBootstrapRetries: value.StreamBootstrapRetries, NonStreamKeepAliveInterval: value.NonStreamKeepAliveInterval,
	}
}

func (a *App) adminNativeSettings(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane != "native" || a.nativeCPARuntime == nil {
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
	if message := validateNativeRuntimeSettings(input); message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	a.nativeSettings.RLock()
	previous := a.nativeSettings.value
	a.nativeSettings.RUnlock()
	if err := a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, input); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "运行配置持久化失败")
		return
	}
	if err := a.nativeCPARuntime.ApplySettings(r.Context(), runtimeBridgeSettings(input)); err != nil {
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
		"ready": a.nativeCPARuntime != nil, "credentials": a.nativeCPARuntime.CredentialCount(), "models": len(a.nativeCPARuntime.Models()),
		"request_timeout_seconds": int(a.cfg.RequestTimeout / time.Second), "max_in_flight": a.cfg.CPAMaxInFlight,
		"max_queue": a.cfg.CPAMaxQueue, "queue_timeout_seconds": int(a.cfg.CPAQueueTimeout / time.Second),
		"max_request_bytes": a.cfg.CPAMaxRequestBytes, "request_bytes_in_flight": a.cfg.CPARequestBytesInFlight,
		"circuit_failure_threshold": a.cfg.CPACircuitFailureThreshold, "circuit_open_seconds": int(a.cfg.CPACircuitOpenDuration / time.Second),
		"executor_cache_pressure_bytes": a.cfg.ExecutorCachePressureBytes, "unpriced_model_policy": a.cfg.UnpricedModelPolicy,
		"request_log_retention_days": a.cfg.RequestLogRetentionDays, "request_success_detail_days": a.cfg.RequestSuccessDetailDays,
		"request_error_detail_days": a.cfg.RequestDetailRetentionDays,
	}
}
