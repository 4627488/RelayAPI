package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type managedOAuthSession struct {
	State         string
	Provider      string
	ProxyURL      string
	OriginalProxy string
	ExistingAuth  map[string]struct{}
}

type providerSettings struct {
	RequestRetry     int    `json:"request_retry"`
	MaxRetryInterval int    `json:"max_retry_interval"`
	RoutingStrategy  string `json:"routing_strategy"`
}

func (a *App) requireCPAManagement(w http.ResponseWriter) bool {
	if strings.TrimSpace(a.cfg.CPAManagementKey) == "" {
		writeError(w, http.StatusServiceUnavailable, "cpa_management_disabled", "未配置 CPA_MANAGEMENT_KEY")
		return false
	}
	return true
}

func (a *App) relayCPA(w http.ResponseWriter, r *http.Request, method, endpoint string, body any) {
	if !a.requireCPAManagement(w) {
		return
	}
	status, payload, err := a.cpa.Management(r.Context(), method, endpoint, body)
	if err != nil {
		writeCPATransportError(w, r, err, "management", "")
		return
	}
	if !json.Valid(payload) {
		writeError(w, http.StatusBadGateway, "invalid_cpa_response", "CPA 返回了无效响应")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func (a *App) adminProviderAccounts(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane == "native" {
		a.nativeProviderAccounts(w, r)
		return
	}
	if !a.requireCPAManagement(w) {
		return
	}
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, "auth-files", nil)
	if err != nil || status < 200 || status >= 300 {
		writeError(w, http.StatusBadGateway, "cpa_unavailable", "无法读取 CPA OAuth 凭据")
		return
	}
	accounts, err := decodeProviderAccounts(payload)
	if err != nil {
		writeError(w, http.StatusBadGateway, "invalid_cpa_response", "CPA 返回了无效的 OAuth 凭据")
		return
	}
	configWarning := ""
	configStatus, configPayload, configErr := a.cpa.Management(r.Context(), http.MethodGet, "config", nil)
	if configErr != nil || configStatus < 200 || configStatus >= 300 {
		configWarning = "无法读取 CPA API Key 配置"
	} else if configured, decodeErr := providerConfigAccounts(configPayload); decodeErr != nil {
		configWarning = "CPA API Key 配置格式无效"
	} else {
		accounts = append(accounts, configured...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": accounts, "warning": configWarning})
}

func (a *App) adminProviderModels(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane == "native" {
		a.nativeProviderModels(w, r)
		return
	}
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "凭据名称不能为空")
		return
	}
	if path, index, ok := parseConfigAccountName(name); ok {
		items, err := a.loadProviderConfigItems(r, path)
		if err != nil || index >= len(items) {
			writeError(w, http.StatusNotFound, "not_found", "API Key 账户不存在")
			return
		}
		var item map[string]any
		if json.Unmarshal(items[index], &item) != nil {
			writeError(w, http.StatusBadGateway, "invalid_cpa_response", "CPA API Key 配置格式无效")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": providerModelNames(item["models"])})
		return
	}
	a.relayCPA(w, r, http.MethodGet, "auth-files/models?name="+url.QueryEscape(name), nil)
}

func (a *App) adminProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane == "native" {
		a.nativeProviderAccountUpdate(w, r)
		return
	}
	var input struct {
		Disabled *bool `json:"disabled"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Disabled == nil {
		writeError(w, http.StatusBadRequest, "validation_error", "disabled 必填")
		return
	}
	if path, index, ok := parseConfigAccountName(strings.TrimSpace(r.PathValue("name"))); ok {
		if path != "openai-compatibility" {
			writeError(w, http.StatusBadRequest, "unsupported_operation", "该 API Key 类型不支持停用，请删除后重新配置")
			return
		}
		items, err := a.loadProviderConfigItems(r, path)
		if err != nil || index >= len(items) {
			writeError(w, http.StatusNotFound, "not_found", "兼容端点不存在")
			return
		}
		var item map[string]any
		if json.Unmarshal(items[index], &item) != nil {
			writeError(w, http.StatusBadGateway, "invalid_cpa_response", "CPA 兼容端点配置格式无效")
			return
		}
		item["disabled"] = *input.Disabled
		items[index], _ = json.Marshal(item)
		status, payload, err := a.saveProviderConfigItems(r, path, items)
		if err != nil || status < 200 || status >= 300 {
			writeError(w, http.StatusBadGateway, "cpa_update_failed", fmt.Sprintf("CPA 配置更新失败：%s", string(payload)))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"disabled": *input.Disabled})
		return
	}
	a.relayCPA(w, r, http.MethodPatch, "auth-files/status", map[string]any{
		"name": r.PathValue("name"), "disabled": input.Disabled,
	})
}

func (a *App) adminProviderAccountDelete(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane == "native" {
		a.nativeProviderAccountDelete(w, r)
		return
	}
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "凭据名称不能为空")
		return
	}
	if path, index, ok := parseConfigAccountName(name); ok {
		items, err := a.loadProviderConfigItems(r, path)
		if err != nil || index >= len(items) {
			writeError(w, http.StatusNotFound, "not_found", "API Key 账户不存在")
			return
		}
		items = append(items[:index], items[index+1:]...)
		status, payload, err := a.saveProviderConfigItems(r, path, items)
		if err != nil || status < 200 || status >= 300 {
			writeError(w, http.StatusBadGateway, "cpa_update_failed", fmt.Sprintf("CPA 配置更新失败：%s", string(payload)))
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	a.relayCPA(w, r, http.MethodDelete, "auth-files?name="+url.QueryEscape(name), nil)
}

func (a *App) adminCodexOAuth(w http.ResponseWriter, r *http.Request) {
	r.SetPathValue("provider", "codex")
	a.adminProviderOAuth(w, r)
}

func (a *App) adminProviderOAuth(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	endpoints := map[string]string{
		"anthropic":   "anthropic-auth-url",
		"codex":       "codex-auth-url",
		"antigravity": "antigravity-auth-url",
		"kimi":        "kimi-auth-url",
		"xai":         "xai-auth-url",
	}
	endpoint, ok := endpoints[provider]
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported_provider", "该提供商不支持 OAuth 登录")
		return
	}
	var input struct {
		ProxyURL string `json:"proxy_url"`
	}
	if r.Body != nil && r.ContentLength != 0 && !decodeJSON(w, r, &input) {
		return
	}
	proxyURL := strings.TrimSpace(input.ProxyURL)
	if err := validateOAuthProxyURL(proxyURL); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_proxy_url", err.Error())
		return
	}

	a.oauthMu.Lock()
	if a.oauthSession != nil {
		a.oauthMu.Unlock()
		writeError(w, http.StatusConflict, "oauth_in_progress", "已有 OAuth 认证正在进行，请完成或等待其超时后再试")
		return
	}
	a.oauthSession = &managedOAuthSession{Provider: provider, ProxyURL: proxyURL}
	a.oauthMu.Unlock()

	session, err := a.prepareManagedOAuth(r.Context(), provider, proxyURL)
	if err != nil {
		a.clearManagedOAuth("")
		writeError(w, http.StatusBadGateway, "oauth_proxy_setup_failed", err.Error())
		return
	}
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, endpoint, nil)
	if err != nil || status < 200 || status >= 300 {
		a.restoreManagedOAuth(r.Context(), session.State)
		if err != nil {
			writeCPATransportError(w, r, err, "oauth_start", "")
		} else {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(status)
			_, _ = w.Write(payload)
		}
		return
	}
	var started struct {
		State string `json:"state"`
	}
	if json.Unmarshal(payload, &started) != nil || strings.TrimSpace(started.State) == "" {
		a.restoreManagedOAuth(r.Context(), session.State)
		writeError(w, http.StatusBadGateway, "invalid_cpa_response", "CPA OAuth 响应缺少 state")
		return
	}
	a.oauthMu.Lock()
	if a.oauthSession != nil {
		a.oauthSession.State = started.State
	}
	a.oauthMu.Unlock()
	time.AfterFunc(6*time.Minute, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		a.restoreManagedOAuth(ctx, started.State)
	})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
	return
	// Relay handles the browser callback explicitly, so CPA does not need to
	// open a callback forwarder on the server.
}

func (a *App) adminOAuthStatus(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "state 必填")
		return
	}
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, "get-auth-status?state="+url.QueryEscape(state), nil)
	if err != nil {
		writeCPATransportError(w, r, err, "oauth_status", "")
		return
	}
	if status >= 200 && status < 300 {
		var result struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(payload, &result) == nil && (result.Status == "ok" || result.Status == "error") {
			if result.Status == "ok" {
				if err := a.bindAndRestoreManagedOAuth(r.Context(), state); err != nil {
					writeError(w, http.StatusBadGateway, "oauth_proxy_bind_failed", err.Error())
					return
				}
			} else {
				a.restoreManagedOAuth(r.Context(), state)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func validateOAuthProxyURL(value string) error {
	if value == "" || value == "direct" || value == "none" {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("代理地址格式无效")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "socks5", "socks5h", "http", "https":
		return nil
	default:
		return fmt.Errorf("代理地址仅支持 socks5、socks5h、http 或 https")
	}
}

func (a *App) prepareManagedOAuth(ctx context.Context, provider, proxyURL string) (*managedOAuthSession, error) {
	session := &managedOAuthSession{Provider: provider, ProxyURL: proxyURL, ExistingAuth: map[string]struct{}{}}
	status, payload, err := a.cpa.Management(ctx, http.MethodGet, "auth-files", nil)
	if err != nil || status < 200 || status >= 300 {
		return nil, fmt.Errorf("无法读取 OAuth 凭据快照")
	}
	accounts, err := decodeProviderAccounts(payload)
	if err != nil {
		return nil, fmt.Errorf("无法解析 OAuth 凭据快照")
	}
	for _, account := range accounts {
		session.ExistingAuth[account.Name] = struct{}{}
	}
	status, payload, err = a.cpa.Management(ctx, http.MethodGet, "proxy-url", nil)
	if err != nil || status < 200 || status >= 300 {
		return nil, fmt.Errorf("无法读取 CPA 原全局代理")
	}
	var current struct {
		ProxyURL string `json:"proxy-url"`
	}
	if json.Unmarshal(payload, &current) != nil {
		return nil, fmt.Errorf("无法解析 CPA 原全局代理")
	}
	session.OriginalProxy = current.ProxyURL
	if proxyURL != "" {
		status, payload, err = a.cpa.Management(ctx, http.MethodPut, "proxy-url", map[string]any{"value": proxyURL})
		if err != nil || status < 200 || status >= 300 {
			return nil, fmt.Errorf("无法在 OAuth 开始前应用代理")
		}
	}
	a.oauthMu.Lock()
	a.oauthSession = session
	a.oauthMu.Unlock()
	return session, nil
}

func (a *App) bindAndRestoreManagedOAuth(ctx context.Context, state string) error {
	a.oauthMu.Lock()
	session := a.oauthSession
	a.oauthMu.Unlock()
	if session == nil || session.State != state {
		return nil
	}
	if session.ProxyURL != "" {
		status, payload, err := a.cpa.Management(ctx, http.MethodGet, "auth-files", nil)
		if err != nil || status < 200 || status >= 300 {
			a.restoreManagedOAuth(ctx, state)
			return fmt.Errorf("认证成功，但无法查找新凭据以绑定代理")
		}
		accounts, err := decodeProviderAccounts(payload)
		if err != nil {
			a.restoreManagedOAuth(ctx, state)
			return fmt.Errorf("认证成功，但 CPA 凭据响应无效")
		}
		name := ""
		credentialProvider := session.Provider
		if credentialProvider == "anthropic" {
			credentialProvider = "claude"
		}
		for _, account := range accounts {
			_, existed := session.ExistingAuth[account.Name]
			if !existed && strings.EqualFold(account.Provider, credentialProvider) {
				name = account.Name
				break
			}
		}
		if name == "" {
			a.restoreManagedOAuth(ctx, state)
			return fmt.Errorf("认证成功，但未能确定新凭据")
		}
		status, payload, err = a.cpa.Management(ctx, http.MethodPatch, "auth-files/fields", map[string]any{"name": name, "proxy_url": session.ProxyURL})
		if err != nil || status < 200 || status >= 300 {
			a.restoreManagedOAuth(ctx, state)
			return fmt.Errorf("认证成功，但长期代理绑定失败")
		}
	}
	a.restoreManagedOAuth(ctx, state)
	return nil
}

func (a *App) restoreManagedOAuth(ctx context.Context, state string) {
	a.oauthMu.Lock()
	session := a.oauthSession
	if session == nil || (state != "" && session.State != "" && session.State != state) {
		a.oauthMu.Unlock()
		return
	}
	a.oauthSession = nil
	a.oauthMu.Unlock()
	if session.ProxyURL == "" {
		return
	}
	if strings.TrimSpace(session.OriginalProxy) == "" {
		_, _, _ = a.cpa.Management(ctx, http.MethodDelete, "proxy-url", nil)
	} else {
		_, _, _ = a.cpa.Management(ctx, http.MethodPut, "proxy-url", map[string]any{"value": session.OriginalProxy})
	}
}

func (a *App) clearManagedOAuth(state string) {
	a.oauthMu.Lock()
	if a.oauthSession != nil && (state == "" || a.oauthSession.State == state) {
		a.oauthSession = nil
	}
	a.oauthMu.Unlock()
}

func (a *App) adminOAuthCallback(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Provider    string `json:"provider"`
		RedirectURL string `json:"redirect_url"`
		Code        string `json:"code"`
		State       string `json:"state"`
		Error       string `json:"error"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.State) == "" && strings.TrimSpace(input.RedirectURL) == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "state 或 redirect_url 必填")
		return
	}
	if input.Provider == "" {
		input.Provider = "codex"
	}
	a.relayCPA(w, r, http.MethodPost, "oauth-callback", input)
}

func (a *App) adminProviderSettings(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DataPlane == "native" {
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
		return
	}
	if !a.requireCPAManagement(w) {
		return
	}
	if r.Method == http.MethodGet {
		var result providerSettings
		for endpoint, target := range map[string]any{
			"request-retry": &struct {
				Value *int `json:"request-retry"`
			}{},
			"max-retry-interval": &struct {
				Value *int `json:"max-retry-interval"`
			}{},
			"routing/strategy": &struct {
				Value *string `json:"strategy"`
			}{},
		} {
			status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, endpoint, nil)
			if err != nil || status < 200 || status >= 300 || json.Unmarshal(payload, target) != nil {
				writeError(w, http.StatusBadGateway, "cpa_unavailable", "无法读取 CPA 配置")
				return
			}
			switch value := target.(type) {
			case *struct {
				Value *int `json:"request-retry"`
			}:
				if value.Value != nil {
					result.RequestRetry = *value.Value
				}
			case *struct {
				Value *int `json:"max-retry-interval"`
			}:
				if value.Value != nil {
					result.MaxRetryInterval = *value.Value
				}
			case *struct {
				Value *string `json:"strategy"`
			}:
				if value.Value != nil {
					result.RoutingStrategy = *value.Value
				}
			}
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	var input providerSettings
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.RequestRetry < 0 || input.RequestRetry > 20 || input.MaxRetryInterval < 0 || input.MaxRetryInterval > 3600 ||
		(input.RoutingStrategy != "round-robin" && input.RoutingStrategy != "fill-first") {
		writeError(w, http.StatusBadRequest, "validation_error", "CPA 配置值无效")
		return
	}
	updates := []struct {
		endpoint string
		value    any
	}{
		{"request-retry", input.RequestRetry},
		{"max-retry-interval", input.MaxRetryInterval},
		{"routing/strategy", input.RoutingStrategy},
	}
	for _, update := range updates {
		status, payload, err := a.cpa.Management(r.Context(), http.MethodPatch, update.endpoint, map[string]any{"value": update.value})
		if err != nil || status < 200 || status >= 300 {
			writeError(w, http.StatusBadGateway, "cpa_update_failed", fmt.Sprintf("CPA 配置更新失败：%s", string(payload)))
			return
		}
	}
	writeJSON(w, http.StatusOK, input)
}
