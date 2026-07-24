package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Email) == "" || len(input.Password) < 8 {
		writeError(w, http.StatusBadRequest, "validation_error", "名称、邮箱必填，密码至少 8 位")
		return
	}
	user, err := a.store.RegisterWithInvitation(r.Context(), input.Token, input.Name, input.Email, input.Password)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_invitation", "邀请无效、已过期或已使用")
		return
	}
	a.setSession(w, identity.Session{
		Role: "tenant", TenantID: user.ID, Expires: time.Now().Add(12 * time.Hour).Unix(),
	})
	writeJSON(w, http.StatusCreated, map[string]any{"role": "tenant", "tenant": user})
}

func (a *App) adminOverview(w http.ResponseWriter, r *http.Request) {
	value, err := a.store.AdminOverview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *App) adminInvitations(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListInvitations(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "database_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}
	var input struct {
		Email          string `json:"email"`
		ExpiresInHours int    `json:"expires_in_hours"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.ExpiresInHours == 0 {
		input.ExpiresInHours = 72
	}
	if input.ExpiresInHours < 1 || input.ExpiresInHours > 24*30 {
		writeError(w, http.StatusBadRequest, "validation_error", "邀请有效期必须为 1 小时至 30 天")
		return
	}
	item, token, err := a.store.CreateInvitation(
		r.Context(), input.Email, time.Now().Add(time.Duration(input.ExpiresInHours)*time.Hour),
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"item":       item,
		"token":      token,
		"invite_url": a.cfg.PublicURL + "/register?token=" + url.QueryEscape(token),
	})
}

func (a *App) adminInvitationRevoke(w http.ResponseWriter, r *http.Request) {
	if err := a.store.RevokeInvitation(r.Context(), r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "邀请不存在或已失效")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type tenantInput struct {
	Name, OwnerEmail, Password string
	Enabled                    bool
	RateLimitPerMinute         *int
	TokenLimitDaily            *int64
	ModelAllowlist             []string
}

type keyInput struct {
	Name               string
	RateLimitPerMinute *int
	TokenLimitDaily    *int64
	ModelAllowlist     []string
}

func (a *App) dashboard(w http.ResponseWriter, r *http.Request) {
	value, err := a.store.Dashboard(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, value)
}

func usageDays(r *http.Request) int {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days < 1 || days > 365 {
		return 30
	}
	return days
}

func (a *App) usage(w http.ResponseWriter, r *http.Request) {
	value, err := a.store.UsageReport(r.Context(), currentSession(r).TenantID, usageDays(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *App) adminUsage(w http.ResponseWriter, r *http.Request) {
	value, err := a.store.UsageReport(
		r.Context(), strings.TrimSpace(r.URL.Query().Get("user_id")), usageDays(r),
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *App) keys(w http.ResponseWriter, r *http.Request) {
	tenantID := currentSession(r).TenantID
	if r.Method == http.MethodGet {
		items, err := a.store.ListKeys(r.Context(), tenantID)
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input keyInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" {
		writeError(w, 400, "validation_error", "密钥名称不能为空")
		return
	}
	item, plain, err := a.store.CreateKey(r.Context(), tenantID, input.Name, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"item": item, "key": plain})
}

func (a *App) keyDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteKey(r.Context(), currentSession(r).TenantID, r.PathValue("id")); err != nil {
		writeError(w, 404, "not_found", "密钥不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) logs(w http.ResponseWriter, r *http.Request) {
	session := currentSession(r)
	tenantID := session.TenantID
	if session.Role == "admin" {
		tenantID = strings.TrimSpace(r.URL.Query().Get("tenant_id"))
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := a.store.RecentLogs(r.Context(), tenantID, limit)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *App) adminTenants(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListTenants(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input tenantInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Name == "" || input.OwnerEmail == "" || len(input.Password) < 8 {
		writeError(w, 400, "validation_error", "名称、邮箱必填，初始密码至少 8 位")
		return
	}
	item, err := a.store.CreateTenant(r.Context(), input.Name, input.OwnerEmail, input.Password,
		input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist)
	if err != nil {
		writeError(w, 409, "create_failed", err.Error())
		return
	}
	writeJSON(w, 201, item)
}

func (a *App) adminTenantUpdate(w http.ResponseWriter, r *http.Request) {
	var input tenantInput
	if !decodeJSON(w, r, &input) {
		return
	}
	item, err := a.store.UpdateTenant(r.Context(), r.PathValue("id"), input.Name, input.OwnerEmail, input.Enabled,
		input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist)
	if err != nil {
		writeError(w, 404, "not_found", "租户不存在")
		return
	}
	writeJSON(w, 200, item)
}

func (a *App) adminCredit(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AmountNanoUSD int64  `json:"amount_nano_usd"`
		Note          string `json:"note"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.AmountNanoUSD == 0 {
		writeError(w, 400, "validation_error", "金额不能为 0")
		return
	}
	if err := a.store.Credit(r.Context(), r.PathValue("id"), input.AmountNanoUSD, input.Note); err != nil {
		writeError(w, 404, "not_found", "租户不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) adminPassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Password) < 8 {
		writeError(w, 400, "validation_error", "密码至少 8 位")
		return
	}
	if err := a.store.ResetPassword(r.Context(), r.PathValue("id"), input.Password); err != nil {
		writeError(w, 404, "not_found", "租户不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) adminTenantKeys(w http.ResponseWriter, r *http.Request) {
	tenantID := r.PathValue("id")
	if r.Method == http.MethodGet {
		items, err := a.store.ListKeys(r.Context(), tenantID)
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input keyInput
	if !decodeJSON(w, r, &input) {
		return
	}
	item, plain, err := a.store.CreateKey(r.Context(), tenantID, input.Name, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"item": item, "key": plain})
}

func (a *App) adminPrices(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListPrices(r.Context())
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *App) adminPriceUpdate(w http.ResponseWriter, r *http.Request) {
	var price store.Price
	if !decodeJSON(w, r, &price) {
		return
	}
	model, err := url.PathUnescape(r.PathValue("model"))
	if err != nil || model == "" {
		writeError(w, 400, "validation_error", "模型名无效")
		return
	}
	price.Model = model
	if min(price.InputNanoUSDPerToken, price.OutputNanoUSDPerToken, price.CachedInputNanoUSDPerToken,
		price.CacheWriteNanoUSDPerToken, price.ReasoningNanoUSDPerToken) < 0 {
		writeError(w, 400, "validation_error", "价格不能为负数")
		return
	}
	if err := a.store.UpsertPrice(r.Context(), price); err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, price)
}

func (a *App) adminCPA(w http.ResponseWriter, r *http.Request) {
	if a.cfg.CPAManagementKey == "" {
		writeError(w, 503, "cpa_management_disabled", "未配置 CPA_MANAGEMENT_KEY")
		return
	}
	allowedResources := map[string]string{"config": "config", "auth-files": "auth-files", "usage": "api-key-usage", "version": "latest-version"}
	path, ok := allowedResources[r.PathValue("resource")]
	if !ok {
		writeError(w, 404, "not_found", "不支持的 CPA 资源")
		return
	}
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, path, nil)
	if err != nil {
		writeError(w, 502, "cpa_unavailable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if !json.Valid(payload) {
		payload = []byte(`{"error":"invalid CPA response"}`)
	}
	_, _ = w.Write(payload)
}
