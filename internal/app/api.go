package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
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
	user, err := a.store.Register(r.Context(), input.Token, input.Name, input.Email, input.Password)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_invitation", "邀请无效、已过期或已使用")
		return
	}
	a.setSession(w, identity.Session{
		Role: "tenant", TenantID: user.ID, PasswordVersion: user.PasswordVersion, Expires: time.Now().Add(12 * time.Hour).Unix(),
	})
	writeJSON(w, http.StatusCreated, map[string]any{"role": "tenant", "is_admin": user.IsAdmin, "tenant": user})
}

func (a *App) authStatus(w http.ResponseWriter, r *http.Request) {
	setupRequired, err := a.store.SetupRequired(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"setup_required": setupRequired})
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
	w.Header().Set("Cache-Control", "no-store")
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
	w.Header().Set("Cache-Control", "no-store")
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
	query := requestLogQuery(r)
	query.TenantID = currentSession(r).TenantID
	page, err := a.store.QueryLogs(r.Context(), query)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, page)
}

func (a *App) adminLogs(w http.ResponseWriter, r *http.Request) {
	query := requestLogQuery(r)
	query.TenantID = strings.TrimSpace(r.URL.Query().Get("tenant_id"))
	page, err := a.store.QueryLogs(r.Context(), query)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, page)
}

func requestLogQuery(r *http.Request) store.LogQuery {
	values := r.URL.Query()
	page, _ := strconv.Atoi(values.Get("page"))
	pageSize, _ := strconv.Atoi(values.Get("page_size"))
	if pageSize == 0 {
		pageSize, _ = strconv.Atoi(values.Get("limit"))
	}
	minLatency, _ := strconv.ParseInt(values.Get("min_latency_ms"), 10, 64)
	return store.LogQuery{
		Page: page, PageSize: pageSize, Query: strings.TrimSpace(values.Get("query")),
		Status: strings.TrimSpace(values.Get("status")), Method: strings.TrimSpace(values.Get("method")),
		Model: strings.TrimSpace(values.Get("model")), From: parseQueryTime(values.Get("from")),
		To: parseQueryTime(values.Get("to")), MinLatencyMS: minLatency,
	}
}

func parseQueryTime(value string) *time.Time {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return nil
	}
	return &parsed
}

func (a *App) logDetail(w http.ResponseWriter, r *http.Request) {
	item, err := a.store.RequestLogDetail(r.Context(), r.PathValue("id"), currentSession(r).TenantID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "请求日志不存在")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *App) adminLogDetail(w http.ResponseWriter, r *http.Request) {
	item, err := a.store.RequestLogDetail(r.Context(), r.PathValue("id"), "")
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "请求日志不存在")
		return
	}
	writeJSON(w, http.StatusOK, item)
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
	if r.PathValue("id") == currentSession(r).TenantID {
		writeError(w, 400, "self_reset_not_allowed", "不能在这里重置自己的密码")
		return
	}
	password, err := identity.NewTemporaryPassword()
	if err != nil {
		writeError(w, 500, "password_generation_failed", "无法生成临时密码")
		return
	}
	if err := a.store.ResetPassword(r.Context(), r.PathValue("id"), password); err != nil {
		writeError(w, 404, "not_found", "租户不存在")
		return
	}
	writeJSON(w, 200, map[string]string{"temporary_password": password})
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Password) < 12 {
		writeError(w, 400, "validation_error", "新密码至少 12 位")
		return
	}
	if err := a.store.ChangePassword(r.Context(), currentSession(r).TenantID, input.Password); err != nil {
		writeError(w, 500, "password_change_failed", "密码修改失败")
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
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 201, map[string]any{"item": item, "key": plain})
}

func (a *App) adminPrices(w http.ResponseWriter, r *http.Request) {
	catalog, err := a.store.ListCatalogPrices(r.Context())
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	catalogSyncError := ""
	if len(catalog) == 0 {
		if syncErr := a.refreshPricingCatalog(r.Context(), true); syncErr != nil {
			catalogSyncError = syncErr.Error()
		} else if catalog, err = a.store.ListCatalogPrices(r.Context()); err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
	}
	availableModels, availableModelsError := a.cpa.Models(r.Context())
	available := make([]store.AvailableModelPrice, 0)
	if availableModelsError == nil {
		available, err = a.store.AvailableModelPrices(r.Context(), availableModels)
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
	}
	availableError := ""
	if availableModelsError != nil {
		availableError = availableModelsError.Error()
	}
	writeJSON(w, 200, map[string]any{
		"available_models": available, "available_models_error": availableError,
		"catalog_sync_error": catalogSyncError,
	})
}

func (a *App) adminPriceUpdate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		InputNanoUSDPerToken       int64    `json:"input_nano_usd_per_token"`
		OutputNanoUSDPerToken      int64    `json:"output_nano_usd_per_token"`
		CachedInputNanoUSDPerToken int64    `json:"cached_input_nano_usd_per_token"`
		CacheWriteNanoUSDPerToken  int64    `json:"cache_write_nano_usd_per_token"`
		ReasoningNanoUSDPerToken   int64    `json:"reasoning_nano_usd_per_token"`
		PriceMultiplier            *float64 `json:"price_multiplier"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	model, err := url.PathUnescape(r.PathValue("model"))
	if err != nil || model == "" {
		writeError(w, 400, "validation_error", "模型名无效")
		return
	}
	multiplier := 1.0
	if input.PriceMultiplier != nil {
		multiplier = *input.PriceMultiplier
	}
	price := store.Price{
		Model: model, InputNanoUSDPerToken: input.InputNanoUSDPerToken,
		OutputNanoUSDPerToken:      input.OutputNanoUSDPerToken,
		CachedInputNanoUSDPerToken: input.CachedInputNanoUSDPerToken,
		CacheWriteNanoUSDPerToken:  input.CacheWriteNanoUSDPerToken,
		ReasoningNanoUSDPerToken:   input.ReasoningNanoUSDPerToken, PriceMultiplier: multiplier,
	}
	if min(price.InputNanoUSDPerToken, price.OutputNanoUSDPerToken, price.CachedInputNanoUSDPerToken,
		price.CacheWriteNanoUSDPerToken, price.ReasoningNanoUSDPerToken) < 0 || multiplier < 0 {
		writeError(w, 400, "validation_error", "价格和倍率不能为负数")
		return
	}
	if err := a.store.UpsertPrice(r.Context(), price); err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	stored, err := a.store.AdminPrice(r.Context(), model)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, stored)
}

func (a *App) adminPriceDelete(w http.ResponseWriter, r *http.Request) {
	model, err := url.PathUnescape(r.PathValue("model"))
	if err != nil || strings.TrimSpace(model) == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "模型名无效")
		return
	}
	if err := a.store.DeletePrice(r.Context(), model); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "管理员价格覆盖不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) adminPricingAliases(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListModelAliases(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input struct {
		Items []db.ModelAlias `json:"items"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := a.store.ReplaceModelAliases(r.Context(), input.Items); err != nil {
		writeError(w, 400, "validation_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": input.Items})
}

func (a *App) adminPricingRules(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListPriceRules(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "fields": pricing.SortedRuleFields()})
		return
	}
	var input struct {
		Items []db.ModelPriceRule `json:"items"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := a.store.ReplacePriceRules(r.Context(), input.Items); err != nil {
		writeError(w, 400, "validation_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": input.Items})
}

func (a *App) adminPricingSync(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	result, err := pricing.FetchModelsDev(ctx, nil, pricing.ModelsDevURL)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pricing_sync_failed", err.Error())
		return
	}
	if r.Method == http.MethodPost {
		a.pricingSyncMu.Lock()
		err := a.store.ApplyCatalog(r.Context(), result)
		a.pricingSyncMu.Unlock()
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
	}
	samples := result.Entries
	if len(samples) > 20 {
		samples = samples[:20]
	}
	writeJSON(w, 200, map[string]any{
		"source": result.Source, "version": result.Version, "url": result.URL,
		"count": len(result.Entries), "applied": r.Method == http.MethodPost, "samples": samples,
	})
}

func (a *App) adminCPA(w http.ResponseWriter, r *http.Request) {
	if !a.requireCPAManagement(w) {
		return
	}
	resource := strings.TrimSpace(r.PathValue("resource"))
	if resource == "" || strings.Contains(resource, "..") || strings.ContainsAny(resource, "\\\x00") {
		writeError(w, http.StatusBadRequest, "invalid_cpa_path", "CPA 管理路径无效")
		return
	}
	if r.URL.RawQuery != "" {
		resource += "?" + r.URL.RawQuery
	}
	var body io.Reader
	if r.Body != nil {
		body = http.MaxBytesReader(w, r.Body, 32<<20)
	}
	status, headers, payload, err := a.cpa.ManagementRaw(r.Context(), r.Method, resource, r.Header.Get("Content-Type"), body)
	if err != nil {
		writeCPATransportError(w, r, err, "management", "")
		return
	}
	if value := headers.Get("Content-Type"); value != "" {
		w.Header().Set("Content-Type", value)
	} else if json.Valid(payload) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
