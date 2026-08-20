package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

const nativeRuntimeSettingsKey = "native-runtime"

const (
	defaultRequestTimeoutSeconds     = 86400
	defaultMaxRequestMiB             = 1024
	defaultRequestBytesInFlightMiB   = 8192
	defaultMemoryReclaimThresholdMiB = 8192
	maxRequestTimeoutSeconds         = 86400
	maxRequestMiB                    = 65536
	maxRequestBytesInFlightMiB       = 262144
	minMemoryReclaimThresholdMiB     = 64
	maxMemoryReclaimThresholdMiB     = 524288
)

type nativeRuntimeSettings struct {
	RoutingStrategy            string `json:"routing_strategy"`
	CredentialFailureThreshold int    `json:"credential_failure_threshold"`
	CredentialCooldownSeconds  int    `json:"credential_cooldown_seconds"`
	SystemProxyID              string `json:"system_proxy_id"`
	RequestTimeoutSeconds      int    `json:"request_timeout_seconds"`
	MaxRequestMiB              int    `json:"max_request_mib"`
	RequestBytesInFlightMiB    int    `json:"request_bytes_in_flight_mib"`
	MemoryReclaimThresholdMiB  int    `json:"memory_reclaim_threshold_mib"`
	UnpricedModelPolicy        string `json:"unpriced_model_policy"`
	UpstreamWebSockets         bool   `json:"upstream_websockets"`
	RequestRetry               int    `json:"request_retry"`
	MaxRetryCredentials        int    `json:"max_retry_credentials"`
	MaxRetryInterval           int    `json:"max_retry_interval"`
	PassthroughHeaders         bool   `json:"passthrough_headers"`
	ImageGenerationMode        string `json:"image_generation_mode"`
	GPTImageBaseModel          string `json:"gpt_image_base_model"`
	VideoResultAuthCacheTTL    string `json:"video_result_auth_cache_ttl"`
	ForceModelPrefix           bool   `json:"force_model_prefix"`
	StreamKeepAliveSeconds     int    `json:"stream_keepalive_seconds"`
	StreamBootstrapRetries     int    `json:"stream_bootstrap_retries"`
	NonStreamKeepAliveInterval int    `json:"nonstream_keepalive_interval"`
	DisableCredentialCooling   bool   `json:"disable_credential_cooling"`
}

type settingsState struct {
	sync.RWMutex
	value nativeRuntimeSettings
}

func defaultNativeRuntimeSettings() nativeRuntimeSettings {
	return nativeRuntimeSettings{
		RoutingStrategy:            "round-robin",
		CredentialFailureThreshold: 3, CredentialCooldownSeconds: 0,
		RequestTimeoutSeconds:     defaultRequestTimeoutSeconds,
		MaxRequestMiB:             defaultMaxRequestMiB,
		RequestBytesInFlightMiB:   defaultRequestBytesInFlightMiB,
		MemoryReclaimThresholdMiB: defaultMemoryReclaimThresholdMiB,
		UnpricedModelPolicy:       "allow",
		UpstreamWebSockets:        true,
		RequestRetry:              2,
		MaxRetryCredentials:       0,
		MaxRetryInterval:          30,
		PassthroughHeaders:        true,
		ImageGenerationMode:       "enabled",
		GPTImageBaseModel:         "gpt-5.4-mini",
		VideoResultAuthCacheTTL:   "3h",
		StreamKeepAliveSeconds:    15,
		StreamBootstrapRetries:    1,
		DisableCredentialCooling:  true,
	}
}

func (a *App) loadNativeRuntimeSettings(ctx context.Context) (nativeRuntimeSettings, bool, string, bool, error) {
	settings := defaultNativeRuntimeSettings()
	var document json.RawMessage
	found, err := a.store.GetRuntimeSetting(ctx, nativeRuntimeSettingsKey, &document)
	if err != nil || !found {
		return settings, found, "", false, err
	}
	if err = json.Unmarshal(document, &settings); err != nil {
		return settings, true, "", false, err
	}
	if settings.CredentialFailureThreshold == 0 {
		settings.CredentialFailureThreshold = defaultNativeRuntimeSettings().CredentialFailureThreshold
	}
	changed := normalizeNativeRuntimeSettings(&settings, document, a.cfg.UpstreamWebSockets, a.cfg.UnpricedModelPolicy)
	var legacy struct {
		ProxyURL string `json:"proxy_url"`
	}
	_ = json.Unmarshal(document, &legacy)
	return settings, true, strings.TrimSpace(legacy.ProxyURL), changed, nil
}

func normalizeNativeRuntimeSettings(value *nativeRuntimeSettings, raw []byte, envWebSockets bool, envUnpriced string) bool {
	if value == nil {
		return false
	}
	defaults := defaultNativeRuntimeSettings()
	changed := false
	if value.RequestTimeoutSeconds <= 0 {
		value.RequestTimeoutSeconds = defaults.RequestTimeoutSeconds
		changed = true
	}
	if value.MaxRequestMiB <= 0 {
		value.MaxRequestMiB = defaults.MaxRequestMiB
		changed = true
	}
	if value.RequestBytesInFlightMiB <= 0 {
		value.RequestBytesInFlightMiB = defaults.RequestBytesInFlightMiB
		changed = true
	}
	if value.MemoryReclaimThresholdMiB <= 0 {
		value.MemoryReclaimThresholdMiB = defaults.MemoryReclaimThresholdMiB
		changed = true
	}
	if !jsonObjectHasKey(raw, "unpriced_model_policy") {
		if envUnpriced == "allow" || envUnpriced == "deny" {
			value.UnpricedModelPolicy = envUnpriced
		} else {
			value.UnpricedModelPolicy = defaults.UnpricedModelPolicy
		}
		changed = true
	}
	if value.UnpricedModelPolicy == "" {
		value.UnpricedModelPolicy = defaults.UnpricedModelPolicy
		changed = true
	}
	if !jsonObjectHasKey(raw, "upstream_websockets") {
		value.UpstreamWebSockets = envWebSockets
		changed = true
	}
	if !jsonObjectHasKey(raw, "request_retry") {
		value.RequestRetry = defaults.RequestRetry
		changed = true
	}
	if !jsonObjectHasKey(raw, "max_retry_credentials") {
		value.MaxRetryCredentials = defaults.MaxRetryCredentials
		changed = true
	}
	if !jsonObjectHasKey(raw, "max_retry_interval") {
		value.MaxRetryInterval = defaults.MaxRetryInterval
		changed = true
	}
	if !jsonObjectHasKey(raw, "passthrough_headers") {
		value.PassthroughHeaders = defaults.PassthroughHeaders
		changed = true
	}
	if !jsonObjectHasKey(raw, "image_generation_mode") || value.ImageGenerationMode == "" {
		value.ImageGenerationMode = defaults.ImageGenerationMode
		changed = true
	}
	if !jsonObjectHasKey(raw, "gpt_image_base_model") || value.GPTImageBaseModel == "" {
		value.GPTImageBaseModel = defaults.GPTImageBaseModel
		changed = true
	}
	if !jsonObjectHasKey(raw, "video_result_auth_cache_ttl") || value.VideoResultAuthCacheTTL == "" {
		value.VideoResultAuthCacheTTL = defaults.VideoResultAuthCacheTTL
		changed = true
	}
	if !jsonObjectHasKey(raw, "stream_keepalive_seconds") {
		value.StreamKeepAliveSeconds = defaults.StreamKeepAliveSeconds
		changed = true
	}
	if !jsonObjectHasKey(raw, "stream_bootstrap_retries") {
		value.StreamBootstrapRetries = defaults.StreamBootstrapRetries
		changed = true
	}
	if !jsonObjectHasKey(raw, "disable_credential_cooling") {
		value.DisableCredentialCooling = value.CredentialCooldownSeconds == 0
		changed = true
	}
	return changed
}

func jsonObjectHasKey(raw []byte, key string) bool {
	var document map[string]json.RawMessage
	if json.Unmarshal(raw, &document) != nil {
		return false
	}
	_, ok := document[key]
	return ok
}

func validateNativeRuntimeSettings(value nativeRuntimeSettings) string {
	if value.RoutingStrategy != "round-robin" && value.RoutingStrategy != "fill-first" {
		return "凭据调度策略无效"
	}
	if value.CredentialFailureThreshold < 1 || value.CredentialFailureThreshold > 20 {
		return "凭据隔离阈值必须在 1 到 20 之间"
	}
	if value.CredentialCooldownSeconds < 0 || value.CredentialCooldownSeconds > 3600 {
		return "凭据冷却时间必须在 0 到 3600 秒之间；0 表示不隔离"
	}
	if value.RequestTimeoutSeconds < 1 || value.RequestTimeoutSeconds > maxRequestTimeoutSeconds {
		return "响应头超时必须在 1 到 86400 秒之间"
	}
	if value.MaxRequestMiB < 1 || value.MaxRequestMiB > maxRequestMiB {
		return "请求体上限必须在 1 到 65536 MiB 之间"
	}
	if value.RequestBytesInFlightMiB < value.MaxRequestMiB || value.RequestBytesInFlightMiB > maxRequestBytesInFlightMiB {
		return "在途内存预算必须不小于请求体上限，且不超过 262144 MiB"
	}
	if value.MemoryReclaimThresholdMiB < minMemoryReclaimThresholdMiB || value.MemoryReclaimThresholdMiB > maxMemoryReclaimThresholdMiB {
		return "内存回收阈值必须在 64 到 524288 MiB 之间"
	}
	if value.UnpricedModelPolicy != "allow" && value.UnpricedModelPolicy != "deny" {
		return "未定价模型策略必须是允许或拒绝"
	}
	if value.RequestRetry < 0 || value.RequestRetry > 20 {
		return "请求重试次数必须在 0 到 20 之间"
	}
	if value.MaxRetryCredentials < 0 || value.MaxRetryCredentials > 100 {
		return "最大凭据尝试数必须在 0 到 100 之间"
	}
	if value.MaxRetryInterval < 0 || value.MaxRetryInterval > 3600 {
		return "最大重试间隔必须在 0 到 3600 秒之间"
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
	return ""
}

func runtimeBridgeSettings(value nativeRuntimeSettings, systemProxyURL string) relaybridge.Settings {
	imageMode := value.ImageGenerationMode
	if imageMode == "disabled" {
		imageMode = "all"
	}
	if strings.TrimSpace(systemProxyURL) == "" {
		systemProxyURL = "direct"
	}
	return relaybridge.Settings{
		RequestRetry: value.RequestRetry, MaxRetryCredentials: value.MaxRetryCredentials,
		MaxRetryInterval: time.Duration(value.MaxRetryInterval) * time.Second,
		RoutingStrategy:  value.RoutingStrategy, ProxyURL: systemProxyURL,
		PassthroughHeaders: value.PassthroughHeaders, DisableImageGeneration: imageMode,
		GPTImage2BaseModel: value.GPTImageBaseModel, VideoResultAuthCacheTTL: value.VideoResultAuthCacheTTL,
		ForceModelPrefix: value.ForceModelPrefix, StreamKeepAliveSeconds: value.StreamKeepAliveSeconds,
		StreamBootstrapRetries: value.StreamBootstrapRetries, NonStreamKeepAliveInterval: value.NonStreamKeepAliveInterval,
		DisableCredentialCooling: value.DisableCredentialCooling,
	}
}

func runtimeSettings(value nativeRuntimeSettings, systemProxyURL string) upstream.Settings {
	if strings.TrimSpace(systemProxyURL) == "" {
		systemProxyURL = "direct"
	}
	return upstream.Settings{
		RoutingStrategy: value.RoutingStrategy, ProxyURL: systemProxyURL,
		FailureThreshold:      value.CredentialFailureThreshold,
		FailureCooldown:       time.Duration(value.CredentialCooldownSeconds) * time.Second,
		ResponseHeaderTimeout: time.Duration(value.RequestTimeoutSeconds) * time.Second,
	}
}

func (a *App) currentNativeSettings() nativeRuntimeSettings {
	if a == nil {
		return defaultNativeRuntimeSettings()
	}
	a.nativeSettings.RLock()
	value := a.nativeSettings.value
	a.nativeSettings.RUnlock()
	if value.MaxRequestMiB > 0 {
		return value
	}
	settings := defaultNativeRuntimeSettings()
	if a.cfg.MaxRequestBytes > 0 {
		settings.MaxRequestMiB = int(a.cfg.MaxRequestBytes >> 20)
	}
	if a.cfg.RequestBytesInFlight > 0 {
		settings.RequestBytesInFlightMiB = int(a.cfg.RequestBytesInFlight >> 20)
	}
	if a.cfg.RequestTimeout > 0 {
		settings.RequestTimeoutSeconds = int(a.cfg.RequestTimeout / time.Second)
	}
	if a.cfg.MemoryReclaimThresholdBytes > 0 {
		settings.MemoryReclaimThresholdMiB = int(a.cfg.MemoryReclaimThresholdBytes >> 20)
	}
	if a.cfg.UnpricedModelPolicy == "allow" || a.cfg.UnpricedModelPolicy == "deny" {
		settings.UnpricedModelPolicy = a.cfg.UnpricedModelPolicy
	}
	settings.UpstreamWebSockets = a.cfg.UpstreamWebSockets
	return settings
}

func (a *App) maxRequestBytes() int64 {
	return int64(a.currentNativeSettings().MaxRequestMiB) << 20
}

func (a *App) requestBytesInFlight() int64 {
	return int64(a.currentNativeSettings().RequestBytesInFlightMiB) << 20
}

func (a *App) requestTimeout() time.Duration {
	return time.Duration(a.currentNativeSettings().RequestTimeoutSeconds) * time.Second
}

func (a *App) memoryReclaimThreshold() uint64 {
	return uint64(a.currentNativeSettings().MemoryReclaimThresholdMiB) << 20
}

func (a *App) unpricedModelPolicy() string {
	return a.currentNativeSettings().UnpricedModelPolicy
}

func (a *App) upstreamWebSockets() bool {
	return a.currentNativeSettings().UpstreamWebSockets
}

func (a *App) adminNativeSettings(w http.ResponseWriter, r *http.Request) {
	if a.nativeCPARuntime == nil {
		writeError(w, http.StatusConflict, "embedded_cpa_required", "此配置仅适用于内置 CPA 数据平面")
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"mode": "embedded_cpa", "settings": a.currentNativeSettings(), "runtime": a.nativeRuntimeInfo()})
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
	previous := a.currentNativeSettings()
	if err := a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, input); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "运行配置持久化失败")
		return
	}
	if err := a.applyNativeRuntimeSettings(r.Context(), input, systemProxyURL); err != nil {
		_ = a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, previous)
		writeError(w, http.StatusInternalServerError, "runtime_update_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mode": "embedded_cpa", "settings": input, "runtime": a.nativeRuntimeInfo()})
}

func (a *App) applyNativeRuntimeSettings(ctx context.Context, input nativeRuntimeSettings, systemProxyURL string) error {
	previous := a.currentNativeSettings()
	previousProxy := "direct"
	if previous.SystemProxyID != "" {
		if proxyURL, err := a.proxyURL(ctx, previous.SystemProxyID); err == nil && proxyURL != "" {
			previousProxy = proxyURL
		}
	}
	if err := a.nativeCPARuntime.ApplySettings(ctx, runtimeBridgeSettings(input, systemProxyURL)); err != nil {
		return err
	}
	a.nativeSettings.Lock()
	a.nativeSettings.value = input
	a.nativeSettings.Unlock()
	a.replaceAdmission(input)
	if previous.UpstreamWebSockets != input.UpstreamWebSockets {
		if err := a.reloadNativeCredentials(ctx); err != nil {
			_ = a.nativeCPARuntime.ApplySettings(ctx, runtimeBridgeSettings(previous, previousProxy))
			a.nativeSettings.Lock()
			a.nativeSettings.value = previous
			a.nativeSettings.Unlock()
			a.replaceAdmission(previous)
			return err
		}
	}
	return nil
}

func (a *App) replaceAdmission(settings nativeRuntimeSettings) {
	if a == nil {
		return
	}
	client := gateway.New(gateway.Options{
		MaxInFlight:             a.cfg.GatewayMaxInFlight,
		MaxQueue:                a.cfg.GatewayMaxQueue,
		MaxRequestBytesInFlight: int64(settings.RequestBytesInFlightMiB) << 20,
		QueueTimeout:            a.cfg.GatewayQueueTimeout,
	})
	a.nativeAdmission.Store(client)
}

func (a *App) nativeRuntimeInfo() map[string]any {
	settings := a.currentNativeSettings()
	credentials, models := 0, 0
	if a.nativeCPARuntime != nil {
		credentials = a.nativeCPARuntime.CredentialCount()
		models = len(a.nativeCPARuntime.Models())
	}
	return map[string]any{
		"ready": a.nativeCPARuntime != nil && a.nativeCPA != nil, "credentials": credentials, "models": models,
		"data_plane":                     "embedded_cpa",
		"upstream_websockets":            settings.UpstreamWebSockets,
		"request_timeout_seconds":        settings.RequestTimeoutSeconds,
		"max_in_flight":                  a.cfg.GatewayMaxInFlight,
		"max_queue":                      a.cfg.GatewayMaxQueue,
		"queue_timeout_seconds":          int(a.cfg.GatewayQueueTimeout / time.Second),
		"max_request_bytes":              int64(settings.MaxRequestMiB) << 20,
		"request_bytes_in_flight":        int64(settings.RequestBytesInFlightMiB) << 20,
		"memory_reclaim_threshold_bytes": uint64(settings.MemoryReclaimThresholdMiB) << 20,
		"unpriced_model_policy":          settings.UnpricedModelPolicy,
		"request_log_retention_days":     a.cfg.RequestLogRetentionDays, "request_success_detail_days": a.cfg.RequestSuccessDetailDays,
		"request_error_detail_days": a.cfg.RequestDetailRetentionDays,
	}
}
