package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/egress"
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
	Name               string   `json:"name"`
	OwnerEmail         string   `json:"owner_email"`
	Password           string   `json:"password"`
	Enabled            bool     `json:"enabled"`
	RateLimitPerMinute *int     `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64   `json:"token_limit_daily"`
	ModelAllowlist     []string `json:"model_allowlist"`
}

type keyInput struct {
	Name               string                `json:"name"`
	Enabled            bool                  `json:"enabled"`
	RateLimitPerMinute *int                  `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64                `json:"token_limit_daily"`
	ModelAllowlist     []string              `json:"model_allowlist"`
	ModelAliases       []db.APIKeyModelAlias `json:"model_aliases"`
}

func normalizeKeyInput(input *keyInput) error {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return errors.New("密钥名称不能为空")
	}
	if input.RateLimitPerMinute != nil && *input.RateLimitPerMinute < 1 {
		return errors.New("每分钟请求数必须大于 0")
	}
	if input.TokenLimitDaily != nil && *input.TokenLimitDaily < 1 {
		return errors.New("每日 Token 数必须大于 0")
	}
	models := make([]string, 0, len(input.ModelAllowlist))
	seenModels := make(map[string]struct{}, len(input.ModelAllowlist))
	for _, model := range input.ModelAllowlist {
		model = strings.TrimSpace(model)
		key := strings.ToLower(model)
		if model == "" {
			continue
		}
		if _, exists := seenModels[key]; exists {
			continue
		}
		seenModels[key] = struct{}{}
		models = append(models, model)
	}
	input.ModelAllowlist = models
	if len(input.ModelAliases) > 100 {
		return errors.New("每个 API Key 最多设置 100 个模型别名")
	}
	aliases := make([]db.APIKeyModelAlias, 0, len(input.ModelAliases))
	seenAliases := make(map[string]struct{}, len(input.ModelAliases))
	for _, item := range input.ModelAliases {
		alias := strings.ToLower(strings.TrimSpace(item.Alias))
		model := strings.TrimSpace(item.Model)
		if alias == "" || model == "" {
			return errors.New("模型别名和目标模型不能为空")
		}
		if len(alias) > 255 || len(model) > 255 {
			return errors.New("模型别名和目标模型不能超过 255 个字符")
		}
		if strings.EqualFold(alias, model) {
			return fmt.Errorf("模型别名 %q 不能指向自身", alias)
		}
		if _, exists := seenAliases[alias]; exists {
			return fmt.Errorf("模型别名 %q 重复", alias)
		}
		if _, collides := seenModels[alias]; collides {
			return fmt.Errorf("模型别名 %q 与已启用模型重名", alias)
		}
		if len(models) > 0 && !allowed(model, models) {
			return fmt.Errorf("模型别名 %q 的目标不在已启用模型中", alias)
		}
		seenAliases[alias] = struct{}{}
		aliases = append(aliases, db.APIKeyModelAlias{Alias: alias, Model: model})
	}
	input.ModelAliases = aliases
	return nil
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
	if err := normalizeKeyInput(&input); err != nil {
		writeError(w, 400, "validation_error", err.Error())
		return
	}
	item, plain, err := a.store.CreateKey(r.Context(), tenantID, input.Name, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist, input.ModelAliases)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	setSensitiveNoStore(w)
	writeJSON(w, 201, map[string]any{"item": item, "key": plain})
}

func (a *App) keyUpdate(w http.ResponseWriter, r *http.Request) {
	var input keyInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := normalizeKeyInput(&input); err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	item, err := a.store.UpdateKey(r.Context(), currentSession(r).TenantID, r.PathValue("id"), input.Name,
		input.Enabled, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist, input.ModelAliases)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "密钥不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func writeKeySecret(w http.ResponseWriter, plain string) {
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusOK, map[string]string{"key": plain})
}

func (a *App) keySecret(w http.ResponseWriter, r *http.Request) {
	plain, err := a.store.RevealKey(r.Context(), currentSession(r).TenantID, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "密钥不存在")
		return
	}
	if errors.Is(err, store.ErrKeyNotRecoverable) {
		writeError(w, http.StatusConflict, "key_not_recoverable", "旧版密钥未保存可恢复密文，请创建新密钥后替换")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "key_decrypt_failed", "密钥解密失败，请检查加密密钥配置")
		return
	}
	writeKeySecret(w, plain)
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
	query.Public = true
	page, err := a.store.QueryLogs(r.Context(), query)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, publicLogPage(page))
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
	writeJSON(w, http.StatusOK, publicLogDetail(item))
}

// Public log responses keep tenant-owned request and response content while
// removing routing, credential, accounting, and diagnostic internals.
func publicLogPage(page store.LogPage) store.LogPage {
	for index := range page.Items {
		redactPublicLog(&page.Items[index])
	}
	return page
}

func publicLogDetail(item store.LogWithDetail) store.LogWithDetail {
	redactPublicLog(&item.Log)
	if item.Detail != nil {
		item.Detail.ForwardedHeaders = "{}"
		item.Detail.ForwardedBody = ""
		item.Detail.ForwardedBodyTruncated = false
		item.Detail.ForwardedBodyBytes = 0
		item.Detail.UpstreamHeaders = "{}"
		item.Detail.ErrorMessage = ""
		item.Detail.ErrorStack = ""
		item.Detail.ErrorCause = ""
		item.Detail.ErrorDetail = ""
		item.Detail.StageTimings = "{}"
	}
	return item
}

func redactPublicLog(log *db.RequestLog) {
	log.TenantID = ""
	log.APIKeyID = ""
	log.ReservationRequestID = nil
	log.UpstreamRequestID = ""
	log.UpstreamTraceID = ""
	log.UpstreamExecutionID = ""
	log.Provider = ""
	log.ExecutorType = ""
	log.AuthType = ""
	log.AuthIndex = ""
	log.ServiceTier = ""
	log.ResponseServiceTier = ""
	log.ParentSubscriptionID = nil
	log.ChildSubscriptionID = nil
	log.ParentSubscriptionName = ""
	log.ChildSubscriptionName = ""
	log.ChannelID = ""
	log.ChannelName = ""
	log.CredentialID = ""
	log.CredentialName = ""
	log.CredentialEmail = ""
	log.TenantName = ""
	log.APIKeyName = ""
	log.APIKeyPrefix = ""
	log.PriceSource = ""
	log.PriceVersion = ""
	log.PriceModel = ""
	log.InputPriceNanoUSD = 0
	log.OutputPriceNanoUSD = 0
	log.CachedPriceNanoUSD = 0
	log.CacheWritePriceNanoUSD = 0
	log.ReasoningPriceNanoUSD = 0
	log.ImageInputPriceNanoUSD = 0
	log.CachedImageInputPriceNanoUSD = 0
	log.ImageOutputPriceNanoUSD = 0
	log.PriceMultiplier = 0
	log.PricingComplete = false
	log.Settled = false
	log.ReservedNanoUSD = 0
	log.ForwardedBodyBytes = 0
	log.StageTimings = "{}"
	log.ErrorMessage = ""
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
	if r.PathValue("id") == currentSession(r).TenantID && !input.Enabled {
		writeError(w, http.StatusBadRequest, "self_disable_not_allowed", "不能停用自己的账户")
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

func (a *App) adminTenantDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == currentSession(r).TenantID {
		writeError(w, http.StatusBadRequest, "self_delete_not_allowed", "不能删除自己的账户")
		return
	}
	if err := a.store.DeleteTenant(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "租户不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, "delete_failed", "删除租户失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	if err := normalizeKeyInput(&input); err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	item, plain, err := a.store.CreateKey(r.Context(), tenantID, input.Name, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist, input.ModelAliases)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	setSensitiveNoStore(w)
	writeJSON(w, 201, map[string]any{"item": item, "key": plain})
}

func (a *App) adminTenantKeyUpdate(w http.ResponseWriter, r *http.Request) {
	var input keyInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := normalizeKeyInput(&input); err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	item, err := a.store.UpdateKey(r.Context(), r.PathValue("id"), r.PathValue("keyID"), input.Name,
		input.Enabled, input.RateLimitPerMinute, input.TokenLimitDaily, input.ModelAllowlist, input.ModelAliases)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "密钥不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) adminTenantKeySecret(w http.ResponseWriter, r *http.Request) {
	plain, err := a.store.RevealKey(r.Context(), r.PathValue("id"), r.PathValue("keyID"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "密钥不存在")
		return
	}
	if errors.Is(err, store.ErrKeyNotRecoverable) {
		writeError(w, http.StatusConflict, "key_not_recoverable", "旧版密钥未保存可恢复密文，请创建新密钥后替换")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "key_decrypt_failed", "密钥解密失败，请检查加密密钥配置")
		return
	}
	writeKeySecret(w, plain)
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
	var availableModels []string
	var availableModelsError error
	if a.nativeRuntime == nil {
		availableModelsError = errors.New("native runtime runtime is unavailable")
	} else {
		availableModels = a.nativeRuntime.Models()
	}
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
	for i := range available {
		attachModelCapability(&available[i], a.capabilityIndex())
	}
	writeJSON(w, 200, map[string]any{
		"available_models": available, "available_models_error": availableError,
		"catalog_sync_error": catalogSyncError,
	})
}

func attachModelCapability(item *store.AvailableModelPrice, index *pricing.CapabilityIndex) {
	if item == nil || index == nil {
		return
	}
	capability, ok := index.Lookup(item.Model)
	if !ok {
		return
	}
	item.DisplayName = capability.Name
	item.ContextWindow = capability.Context
	item.MaxOutputTokens = capability.MaxOutput
	item.ReasoningEfforts = capability.EffortValues()
	item.DefaultReasoningLevel = capability.DefaultLevel
	item.InputModalities = append([]string(nil), capability.InputModalities...)
	item.PreferWebSockets = capability.PreferWebSockets
	item.CapabilitySource = capability.Source
	if item.DefaultReasoningLevel == "" && len(item.ReasoningEfforts) > 0 {
		item.DefaultReasoningLevel = item.ReasoningEfforts[0]
	}
}

func (a *App) adminPriceUpdate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		InputNanoUSDPerToken            int64    `json:"input_nano_usd_per_token"`
		OutputNanoUSDPerToken           int64    `json:"output_nano_usd_per_token"`
		CachedInputNanoUSDPerToken      int64    `json:"cached_input_nano_usd_per_token"`
		CacheWriteNanoUSDPerToken       int64    `json:"cache_write_nano_usd_per_token"`
		ReasoningNanoUSDPerToken        int64    `json:"reasoning_nano_usd_per_token"`
		ImageInputNanoUSDPerToken       int64    `json:"image_input_nano_usd_per_token"`
		CachedImageInputNanoUSDPerToken int64    `json:"cached_image_input_nano_usd_per_token"`
		ImageOutputNanoUSDPerToken      int64    `json:"image_output_nano_usd_per_token"`
		PriceMultiplier                 *float64 `json:"price_multiplier"`
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
		ImageInputNanoUSDPerToken:       input.ImageInputNanoUSDPerToken,
		CachedImageInputNanoUSDPerToken: input.CachedImageInputNanoUSDPerToken,
		ImageOutputNanoUSDPerToken:      input.ImageOutputNanoUSDPerToken,
	}
	if min(price.InputNanoUSDPerToken, price.OutputNanoUSDPerToken, price.CachedInputNanoUSDPerToken,
		price.CacheWriteNanoUSDPerToken, price.ReasoningNanoUSDPerToken, price.ImageInputNanoUSDPerToken,
		price.CachedImageInputNanoUSDPerToken, price.ImageOutputNanoUSDPerToken) < 0 || multiplier < 0 {
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

func (a *App) adminModelSettingUpdate(w http.ResponseWriter, r *http.Request) {
	model, err := url.PathUnescape(r.PathValue("model"))
	if err != nil || strings.TrimSpace(model) == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "模型名无效")
		return
	}
	var input db.ModelSetting
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Model = model
	item, err := a.store.UpsertModelSetting(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	a.loadCapabilitiesFromStore(r.Context())
	writeJSON(w, http.StatusOK, item)
}

func (a *App) adminModelSettingDelete(w http.ResponseWriter, r *http.Request) {
	model, err := url.PathUnescape(r.PathValue("model"))
	if err != nil || strings.TrimSpace(model) == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "模型名无效")
		return
	}
	if err := a.store.DeleteModelSetting(r.Context(), model); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "模型能力覆盖不存在")
		return
	}
	a.loadCapabilitiesFromStore(r.Context())
	w.WriteHeader(http.StatusNoContent)
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
	proxyURL, err := a.systemProxyURL(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pricing_sync_failed", "无法读取系统代理")
		return
	}
	client, err := egress.OutboundHTTPClient(proxyURL, 30*time.Second)
	if err != nil {
		writeError(w, http.StatusBadGateway, "pricing_sync_failed", err.Error())
		return
	}
	result, err := pricing.FetchModelsDev(ctx, client, pricing.ModelsDevURL)
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
	a.setCapabilities(a.mergeCapabilityIndex(r.Context(), result.Version, result.Capabilities))
	samples := result.Entries
	if len(samples) > 20 {
		samples = samples[:20]
	}
	writeJSON(w, 200, map[string]any{
		"source": result.Source, "version": result.Version, "url": result.URL,
		"count": len(result.Entries), "applied": r.Method == http.MethodPost, "samples": samples,
	})
}
