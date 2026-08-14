package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) nativeProviderAccounts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var input struct {
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Provider string          `json:"provider"`
			Enabled  *bool           `json:"enabled"`
			Models   []string        `json:"models"`
			Document json.RawMessage `json:"document"`
			Method   string          `json:"method"`
			APIKey   string          `json:"api_key"`
			BaseURL  string          `json:"base_url"`
			ProxyID  string          `json:"proxy_id"`
			Prefix   string          `json:"prefix"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
		var supported bool
		input.Provider, supported = normalizeSupportedProvider(input.Provider)
		if !supported {
			writeError(w, http.StatusBadRequest, "unsupported_provider", "仅支持 Codex、Kimi、xAI/Grok、OpenAI 和阿里云百炼")
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		// New credentials always derive their initial public catalog from CPA.
		// Ignore legacy client-supplied model text instead of letting it define
		// provider capability.
		input.Models = nil
		input.Method = strings.ToLower(strings.TrimSpace(input.Method))
		if input.Method == "api_key" {
			if strings.TrimSpace(input.APIKey) == "" {
				writeError(w, http.StatusBadRequest, "validation_error", "API Key 必填")
				return
			}
			documentProvider := input.Provider
			if input.Provider == "aliyun-bailian" {
				documentProvider = "openai-compatibility"
			}
			document := map[string]any{"type": documentProvider, "api_key": strings.TrimSpace(input.APIKey), "auth_kind": "api_key"}
			baseURL := strings.TrimSpace(input.BaseURL)
			if baseURL == "" {
				switch input.Provider {
				case "openai":
					baseURL = "https://api.openai.com/v1"
				case "aliyun-bailian":
					baseURL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
				}
			}
			if baseURL != "" {
				if !validNativeBaseURL(baseURL) {
					writeError(w, http.StatusBadRequest, "validation_error", "接口地址必须是有效的 HTTP(S) URL")
					return
				}
				document["base_url"] = baseURL
			}
			if value := strings.TrimSpace(input.Prefix); value != "" {
				value, prefixErr := normalizeNativePrefix(value)
				if prefixErr != nil {
					writeError(w, http.StatusBadRequest, "validation_error", prefixErr.Error())
					return
				}
				document["prefix"] = value
			}
			input.Document, _ = json.Marshal(document)
		}
		if input.Provider == "" || input.Name == "" || !json.Valid(input.Document) {
			writeError(w, http.StatusBadRequest, "validation_error", "名称、提供商和有效凭据 JSON 均为必填项")
			return
		}
		if documentErr := validateSupportedCredentialDocument(input.Provider, input.Document); documentErr != nil {
			writeError(w, http.StatusBadRequest, "unsupported_credential", documentErr.Error())
			return
		}
		id := strings.TrimSpace(input.ID)
		if id == "" {
			id = nativeCredentialID(input.Provider)
		}
		if _, existingErr := a.store.GetUpstreamCredential(r.Context(), id); existingErr == nil {
			writeError(w, http.StatusConflict, "credential_exists", "凭据 ID 已存在")
			return
		} else if !errors.Is(existingErr, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法检查凭据 ID")
			return
		}
		enabled := true
		if input.Enabled != nil {
			enabled = *input.Enabled
		}
		source := "import"
		if input.Method == "api_key" {
			source = "api_key"
		}
		proxyID, proxyErr := a.validProxyID(r.Context(), input.ProxyID)
		if proxyErr != nil {
			writeError(w, http.StatusBadRequest, "proxy_not_found", proxyErr.Error())
			return
		}
		input.Document = stripCredentialProxyFields(input.Document)
		row, err := a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: id, Name: input.Name, Provider: input.Provider, Enabled: enabled, Models: input.Models, Document: input.Document, Source: source, ProxyID: proxyID})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "credential_save_failed", "保存凭据失败")
			return
		}
		row, _, err = a.activateNativeCredential(r.Context(), row)
		if err != nil {
			_ = a.store.DeleteUpstreamCredential(r.Context(), id)
			_ = a.reloadNativeCredentials(r.Context())
			writeError(w, http.StatusBadRequest, "credential_invalid", err.Error())
			return
		}
		if _, err = a.syncNativeParentSubscriptionRows(r.Context()); err != nil {
			writeError(w, http.StatusInternalServerError, "subscription_sync_failed", "账户已保存，但父订阅同步失败")
			return
		}
		writeJSON(w, http.StatusCreated, nativeProviderAccount(row))
		return
	}
	rows, err := a.store.ListUpstreamCredentials(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credentials_unavailable", "无法读取 native 凭据")
		return
	}
	parents, err := a.store.ListParentSubscriptions(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "subscriptions_unavailable", "无法读取账户额度")
		return
	}
	parentsByCredential := make(map[string]store.ParentSubscription, len(parents)*2)
	for _, parent := range parents {
		if id := strings.TrimSpace(parent.CPAAuthID); id != "" {
			parentsByCredential[id] = parent
		}
		if index := strings.TrimSpace(parent.CPAAuthIndex); index != "" {
			parentsByCredential[index] = parent
		}
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		item := nativeProviderAccount(row)
		if parent, ok := parentsByCredential[row.ID]; ok {
			item["parent_subscription_id"] = parent.ID
			item["capacity_mode"] = parent.CapacityMode
			item["quota_supported"] = parent.QuotaSupported
			item["quota_probe_status"] = parent.QuotaProbeStatus
			item["quota_probe_error"] = parent.QuotaProbeError
			item["quota_observed_at"] = parent.QuotaObservedAt
			item["quota_snapshot"] = parent.QuotaSnapshot
			if plan := strings.TrimSpace(parent.PlanType); plan != "" && plan != "native" {
				item["plan_type"] = plan
			}
		}
		if a.nativeRuntime != nil {
			if status, ok := a.nativeRuntime.CredentialStatus(row.ID); ok {
				item["status"] = status.Status
				item["status_message"] = status.StatusMessage
				item["unavailable"] = item["unavailable"].(bool) || status.Unavailable
				item["success"] = status.Success
				item["failed"] = status.Failed
				if !status.LastRefreshedAt.IsZero() {
					item["last_refreshed_at"] = status.LastRefreshedAt
				}
				if !status.NextRetryAfter.IsZero() {
					item["next_retry_after"] = status.NextRetryAfter
				}
				item["quota_exceeded"] = status.QuotaExceeded
				item["quota_reason"] = status.QuotaReason
				if !status.QuotaRecoverAt.IsZero() {
					item["quota_recover_at"] = status.QuotaRecoverAt
				}
				if _, exists := item["plan_type"]; !exists && status.PlanType != "" {
					item["plan_type"] = status.PlanType
				}
			}
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": items, "mode": "native"})
}

func nativeProviderAccount(row store.UpstreamCredentialSnapshot) map[string]any {
	var document map[string]any
	_ = json.Unmarshal(row.Document, &document)
	email, _ := document["email"].(string)
	baseURL, _ := document["base_url"].(string)
	prefix, _ := document["prefix"].(string)
	websockets, _ := document["websockets"].(bool)
	expired := row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now())
	result := map[string]any{"id": row.ID, "auth_index": row.ID, "name": row.ID, "label": row.Name, "provider": row.Provider, "type": row.Provider,
		"disabled": !row.Enabled, "unavailable": expired, "status": "native", "source": row.Source, "models": row.Models,
		"proxy_configured": row.ProxyID != nil, "proxy_id": row.ProxyID, "websockets": websockets,
		"revision": row.Revision, "can_inspect": true, "can_toggle": true, "can_delete": true,
		"can_replace_document": row.Source == "import" || row.Source == "config" || row.Source == "native"}
	authKind := nativeCredentialAuthKind(document, row.Source)
	if authKind != "" {
		result["auth_kind"] = authKind
	}
	if strings.TrimSpace(email) != "" {
		result["email"] = email
	}
	if strings.TrimSpace(baseURL) != "" {
		result["base_url"] = baseURL
	}
	if strings.TrimSpace(prefix) != "" {
		result["prefix"] = prefix
	}
	if rawHeaders, ok := document["headers"].(map[string]any); ok && len(rawHeaders) > 0 {
		names := make([]string, 0, len(rawHeaders))
		for name := range rawHeaders {
			names = append(names, name)
		}
		sort.Strings(names)
		result["custom_header_names"] = names
	}
	if row.ExpiresAt != nil {
		result["expires_at"] = row.ExpiresAt
	}
	return result
}

func nativeCredentialAuthKind(document map[string]any, source string) string {
	authKind, _ := document["auth_kind"].(string)
	if authKind == "" {
		if apiKey, _ := document["api_key"].(string); strings.TrimSpace(apiKey) != "" {
			authKind = "api_key"
		} else if accessToken, _ := document["access_token"].(string); strings.TrimSpace(accessToken) != "" {
			authKind = "oauth"
		}
	}
	if authKind == "" && source == "oauth" {
		return "oauth"
	}
	if authKind == "" && source == "api_key" {
		return "api_key"
	}
	return authKind
}

func nativeCredentialID(provider string) string {
	var value [8]byte
	_, _ = rand.Read(value[:])
	return strings.ToLower(strings.TrimSpace(provider)) + "-" + hex.EncodeToString(value[:])
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func equalFoldedStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, value := range left {
		counts[strings.ToLower(strings.TrimSpace(value))]++
	}
	for _, value := range right {
		key := strings.ToLower(strings.TrimSpace(value))
		if counts[key] == 0 {
			return false
		}
		counts[key]--
	}
	return true
}

func validateNativeCredentialModels(models, candidates []string) error {
	if len(candidates) == 0 {
		return errors.New("CPA 凭据目录为空")
	}
	allowedModels := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		allowedModels[strings.ToLower(strings.TrimSpace(candidate))] = struct{}{}
	}
	for _, model := range models {
		if _, ok := allowedModels[strings.ToLower(strings.TrimSpace(model))]; !ok {
			return errors.New("模型 " + model + " 不在 CPA 凭据目录中")
		}
	}
	return nil
}

func (a *App) nativeProviderModels(w http.ResponseWriter, r *http.Request) {
	row, err := a.store.GetUpstreamCredential(r.Context(), strings.TrimSpace(r.PathValue("name")))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "凭据不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法读取凭据")
		return
	}
	models := append([]string(nil), row.Models...)
	source := "configured"
	var discoveryError string
	if a.nativeRuntime != nil && row.Enabled {
		discovered, discoveredSource, discoverErr := a.nativeRuntime.DiscoverCredentialModels(r.Context(), row.ID)
		if len(discovered) > 0 {
			models = discovered
			source = discoveredSource
		}
		if discoverErr != nil {
			discoveryError = discoverErr.Error()
		}
	}
	response := map[string]any{"models": models, "source": source}
	if discoveryError != "" {
		response["warning"] = discoveryError
	}
	writeJSON(w, http.StatusOK, response)
}

// activateNativeCredential installs a newly saved credential into CPA. When
// no explicit public model list was supplied, CPA becomes the source of truth:
// native providers use its static registry and OpenAI-compatible providers
// (including Alibaba Cloud Model Studio) enumerate the upstream /models API
// through CPA's credential-aware executor.
func (a *App) activateNativeCredential(ctx context.Context, row store.UpstreamCredentialSnapshot) (store.UpstreamCredentialSnapshot, string, error) {
	if err := a.reloadNativeCredentials(ctx); err != nil {
		return row, "", err
	}
	if len(row.Models) > 0 {
		return row, "configured", nil
	}
	if a.nativeRuntime == nil {
		return row, "", errors.New("embedded CPA runtime is unavailable")
	}
	models, source, err := a.nativeRuntime.DiscoverCredentialModels(ctx, row.ID)
	if err != nil && len(models) == 0 {
		return row, "", err
	}
	models = uniqueStrings(models)
	if len(models) == 0 {
		return row, "", errors.New("CPA 未能枚举该凭据的模型；当前提供商暂不支持自动接入")
	}
	updated, err := a.store.UpsertUpstreamCredential(ctx, store.UpstreamCredentialInput{
		ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
		Models: models, Document: row.Document, Source: row.Source, ProxyID: row.ProxyID, ExpiresAt: row.ExpiresAt,
	})
	if err != nil {
		return row, "", err
	}
	if err = a.reloadNativeCredentials(ctx); err != nil {
		return row, "", err
	}
	return updated, source, nil
}

type nativeProviderUpdateInput struct {
	Disabled   *bool              `json:"disabled"`
	Name       *string            `json:"name"`
	Models     *[]string          `json:"models"`
	BaseURL    *string            `json:"base_url"`
	ProxyID    *string            `json:"proxy_id"`
	Prefix     *string            `json:"prefix"`
	APIKey     *string            `json:"api_key"`
	WebSockets *bool              `json:"websockets"`
	Headers    *map[string]string `json:"headers"`
	Document   json.RawMessage    `json:"document"`
}

func (input nativeProviderUpdateInput) empty() bool {
	return input.Disabled == nil && input.Name == nil && input.Models == nil && input.BaseURL == nil &&
		input.ProxyID == nil && input.Prefix == nil && input.APIKey == nil && input.WebSockets == nil &&
		input.Headers == nil && input.Document == nil
}

func updateNativeCredentialDocument(current json.RawMessage, source string, input nativeProviderUpdateInput) (json.RawMessage, error) {
	documentBytes := current
	if input.Document != nil {
		documentBytes = input.Document
	}
	var document map[string]any
	if !json.Valid(documentBytes) || json.Unmarshal(documentBytes, &document) != nil || document == nil {
		return nil, errors.New("凭据 JSON 必须是有效对象")
	}
	setString := func(key string, value *string) {
		if value == nil {
			return
		}
		trimmed := strings.TrimSpace(*value)
		if trimmed == "" {
			delete(document, key)
		} else {
			document[key] = trimmed
		}
	}
	if input.BaseURL != nil {
		if nativeCredentialAuthKind(document, source) == "oauth" {
			return nil, errors.New("OAuth 账户的接口地址由提供商管理")
		}
		value := strings.TrimSpace(*input.BaseURL)
		if value != "" && !validNativeBaseURL(value) {
			return nil, errors.New("接口地址必须是有效的 HTTP(S) URL")
		}
		setString("base_url", input.BaseURL)
	}
	delete(document, "proxy_url")
	delete(document, "_relay_proxy_url")
	if input.Prefix != nil {
		value, err := normalizeNativePrefix(*input.Prefix)
		if err != nil {
			return nil, err
		}
		input.Prefix = &value
		setString("prefix", input.Prefix)
	}
	if input.APIKey != nil {
		if nativeCredentialAuthKind(document, source) != "api_key" {
			return nil, errors.New("只有 API Key 账户可以轮换 API Key")
		}
		value := strings.TrimSpace(*input.APIKey)
		if value == "" {
			return nil, errors.New("新 API Key 不能为空")
		}
		document["api_key"] = value
	}
	if input.WebSockets != nil {
		document["websockets"] = *input.WebSockets
	}
	if input.Headers != nil {
		headers := make(map[string]string, len(*input.Headers))
		for name, value := range *input.Headers {
			name = strings.TrimSpace(name)
			if name == "" || strings.ContainsAny(name, "\r\n:") || strings.ContainsAny(value, "\r\n") {
				return nil, errors.New("自定义请求头名称或值无效")
			}
			headers[name] = value
		}
		if len(headers) == 0 {
			delete(document, "headers")
		} else {
			document["headers"] = headers
		}
	}
	updated, err := json.Marshal(document)
	return json.RawMessage(updated), err
}

func validNativeBaseURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func normalizeNativePrefix(value string) (string, error) {
	value = strings.Trim(strings.TrimSpace(value), "/")
	if strings.Contains(value, "/") {
		return "", errors.New("模型前缀只能是单个路径段")
	}
	return value, nil
}

func (a *App) nativeProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
	var input nativeProviderUpdateInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.empty() {
		writeError(w, http.StatusBadRequest, "validation_error", "至少提供一个可更新字段")
		return
	}
	id := strings.TrimSpace(r.PathValue("name"))
	row, err := a.store.GetUpstreamCredential(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "凭据不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法读取凭据")
		return
	}
	previous := row
	document, documentErr := updateNativeCredentialDocument(row.Document, row.Source, input)
	if documentErr != nil {
		writeError(w, http.StatusBadRequest, "validation_error", documentErr.Error())
		return
	}
	if documentErr = validateSupportedCredentialDocument(row.Provider, document); documentErr != nil {
		writeError(w, http.StatusBadRequest, "unsupported_credential", documentErr.Error())
		return
	}
	name, models, enabled := row.Name, row.Models, row.Enabled
	proxyID := row.ProxyID
	if input.ProxyID != nil {
		proxyID, err = a.validProxyID(r.Context(), *input.ProxyID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "proxy_not_found", err.Error())
			return
		}
	}
	if input.Disabled != nil {
		enabled = !*input.Disabled
	}
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "validation_error", "账户名称不能为空")
			return
		}
	}
	if input.Models != nil {
		models = uniqueStrings(*input.Models)
		if len(models) == 0 {
			writeError(w, http.StatusBadRequest, "validation_error", "至少选择一个 CPA 模型")
			return
		}
		if !enabled && !equalFoldedStrings(models, row.Models) {
			writeError(w, http.StatusConflict, "credential_disabled", "请先启用账户，再从 CPA 选择模型")
			return
		}
	}
	rollback := func() {
		_, _ = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: previous.ID, Name: previous.Name, Provider: previous.Provider, Enabled: previous.Enabled, Models: previous.Models, Document: previous.Document, Source: previous.Source, ProxyID: previous.ProxyID, ExpiresAt: previous.ExpiresAt})
		_ = a.reloadNativeCredentials(r.Context())
	}
	row, err = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: row.ID, Name: name, Provider: row.Provider, Enabled: enabled, Models: models, Document: document, Source: row.Source, ProxyID: proxyID, ExpiresAt: row.ExpiresAt})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_update_failed", "更新 native 凭据失败")
		return
	}
	if err = a.reloadNativeCredentials(r.Context()); err != nil {
		rollback()
		writeError(w, http.StatusBadRequest, "credential_invalid", err.Error())
		return
	}
	if input.Models != nil && enabled {
		if a.nativeRuntime == nil {
			rollback()
			writeError(w, http.StatusServiceUnavailable, "model_catalog_unavailable", "embedded CPA runtime is unavailable")
			return
		}
		candidates, _, discoverErr := a.nativeRuntime.DiscoverCredentialModels(r.Context(), row.ID)
		if discoverErr != nil && len(candidates) == 0 {
			rollback()
			writeError(w, http.StatusBadGateway, "model_catalog_unavailable", discoverErr.Error())
			return
		}
		if err = validateNativeCredentialModels(models, candidates); err != nil {
			rollback()
			writeError(w, http.StatusBadRequest, "model_not_in_cpa_catalog", err.Error())
			return
		}
	}
	if _, err = a.syncNativeParentSubscriptionRows(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "subscription_sync_failed", "账户已更新，但父订阅同步失败")
		return
	}
	writeJSON(w, http.StatusOK, nativeProviderAccount(row))
}

func (a *App) nativeProviderAccountDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("name"))
	if err := a.store.DeleteUpstreamCredential(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "凭据不存在")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_delete_failed", "删除凭据失败")
		return
	}
	if err := a.reloadNativeCredentials(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "runtime_update_failed", "凭据已删除，但运行时刷新失败")
		return
	}
	if _, err := a.syncNativeParentSubscriptionRows(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "subscription_sync_failed", "账户已删除，但父订阅同步失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
