package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

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
		writeError(w, http.StatusBadGateway, "cpa_unavailable", err.Error())
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
	a.relayCPA(w, r, http.MethodGet, "auth-files", nil)
}

func (a *App) adminProviderModels(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "凭据名称不能为空")
		return
	}
	a.relayCPA(w, r, http.MethodGet, "auth-files/models?name="+url.QueryEscape(name), nil)
}

func (a *App) adminProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
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
	a.relayCPA(w, r, http.MethodPatch, "auth-files/status", map[string]any{
		"name": r.PathValue("name"), "disabled": input.Disabled,
	})
}

func (a *App) adminProviderAccountDelete(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "凭据名称不能为空")
		return
	}
	a.relayCPA(w, r, http.MethodDelete, "auth-files?name="+url.QueryEscape(name), nil)
}

func (a *App) adminCodexOAuth(w http.ResponseWriter, r *http.Request) {
	// Relay handles the browser callback explicitly, so CPA does not need to open
	// a localhost callback forwarder.
	a.relayCPA(w, r, http.MethodGet, "codex-auth-url", nil)
}

func (a *App) adminOAuthStatus(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "state 必填")
		return
	}
	a.relayCPA(w, r, http.MethodGet, "get-auth-status?state="+url.QueryEscape(state), nil)
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
