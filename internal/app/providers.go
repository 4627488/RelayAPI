package app

import (
	"net/http"
)

type providerSettings struct {
	RequestRetry     int    `json:"request_retry"`
	MaxRetryInterval int    `json:"max_retry_interval"`
	RoutingStrategy  string `json:"routing_strategy"`
}

func (a *App) adminProviderAccounts(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccounts(w, r)
}

func (a *App) adminProviderModels(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderModels(w, r)
}

func (a *App) adminProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccountUpdate(w, r)
}

func (a *App) adminProviderAccountDelete(w http.ResponseWriter, r *http.Request) {
	a.nativeProviderAccountDelete(w, r)
}

func (a *App) adminProviderSettings(w http.ResponseWriter, r *http.Request) {
	a.nativeSettings.RLock()
	current := a.nativeSettings.value
	a.nativeSettings.RUnlock()
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, providerSettings{RequestRetry: current.RequestRetry, MaxRetryInterval: current.MaxRetryInterval, RoutingStrategy: current.RoutingStrategy})
		return
	}
	var input providerSettings
	if !decodeJSON(w, r, &input) {
		return
	}
	current.RequestRetry = input.RequestRetry
	current.MaxRetryInterval = input.MaxRetryInterval
	current.RoutingStrategy = input.RoutingStrategy
	if message := validateNativeRuntimeSettings(current); message != "" {
		writeError(w, http.StatusBadRequest, "validation_error", message)
		return
	}
	a.nativeSettings.RLock()
	previous := a.nativeSettings.value
	a.nativeSettings.RUnlock()
	if err := a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, current); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "配置持久化失败")
		return
	}
	if err := a.nativeCPARuntime.ApplySettings(r.Context(), runtimeBridgeSettings(current)); err != nil {
		_ = a.store.PutRuntimeSetting(r.Context(), nativeRuntimeSettingsKey, previous)
		writeError(w, http.StatusInternalServerError, "runtime_update_failed", err.Error())
		return
	}
	a.nativeSettings.Lock()
	a.nativeSettings.value = current
	a.nativeSettings.Unlock()
	writeJSON(w, http.StatusOK, input)
}
