package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
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
			ProxyURL string          `json:"proxy_url"`
			Prefix   string          `json:"prefix"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
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
				document["base_url"] = baseURL
			}
			if value := strings.TrimSpace(input.ProxyURL); value != "" {
				document["proxy_url"] = value
			}
			if value := strings.TrimSpace(input.Prefix); value != "" {
				document["prefix"] = value
			}
			input.Document, _ = json.Marshal(document)
		}
		if input.Provider == "" || input.Name == "" || !json.Valid(input.Document) {
			writeError(w, http.StatusBadRequest, "validation_error", "名称、提供商和有效凭据 JSON 均为必填项")
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
		row, err := a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: id, Name: input.Name, Provider: input.Provider, Enabled: enabled, Models: input.Models, Document: input.Document, Source: source})
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
		writeJSON(w, http.StatusCreated, nativeProviderAccount(row))
		return
	}
	rows, err := a.store.ListUpstreamCredentials(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credentials_unavailable", "无法读取 native 凭据")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, nativeProviderAccount(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": items, "mode": "native"})
}

func nativeProviderAccount(row store.UpstreamCredentialSnapshot) map[string]any {
	var document map[string]any
	_ = json.Unmarshal(row.Document, &document)
	email, _ := document["email"].(string)
	baseURL, _ := document["base_url"].(string)
	prefix, _ := document["prefix"].(string)
	proxyURL, _ := document["proxy_url"].(string)
	if proxyURL == "" {
		proxyURL, _ = document["_relay_proxy_url"].(string)
	}
	expired := row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now())
	result := map[string]any{"id": row.ID, "auth_index": row.ID, "name": row.ID, "label": row.Name, "provider": row.Provider, "type": row.Provider,
		"disabled": !row.Enabled, "unavailable": expired, "status": "native", "source": row.Source, "models": row.Models,
		"proxy_configured": strings.TrimSpace(proxyURL) != "", "revision": row.Revision, "can_inspect": true, "can_toggle": true, "can_delete": true}
	authKind, _ := document["auth_kind"].(string)
	if authKind == "" {
		if apiKey, _ := document["api_key"].(string); strings.TrimSpace(apiKey) != "" {
			authKind = "api_key"
		} else if accessToken, _ := document["access_token"].(string); strings.TrimSpace(accessToken) != "" {
			authKind = "oauth"
		}
	}
	if authKind == "" && row.Source == "oauth" {
		authKind = "oauth"
	}
	if authKind == "" && row.Source == "api_key" {
		authKind = "api_key"
	}
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
	return result
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
	if a.nativeCPARuntime != nil && row.Enabled {
		discovered, discoveredSource, discoverErr := a.nativeCPARuntime.DiscoverCredentialModels(r.Context(), row.ID)
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
	if a.nativeCPARuntime == nil {
		return row, "", errors.New("embedded CPA runtime is unavailable")
	}
	models, source, err := a.nativeCPARuntime.DiscoverCredentialModels(ctx, row.ID)
	if err != nil && len(models) == 0 {
		return row, "", err
	}
	models = uniqueStrings(models)
	if len(models) == 0 {
		return row, "", errors.New("CPA 未能枚举该凭据的模型；当前提供商暂不支持自动接入")
	}
	updated, err := a.store.UpsertUpstreamCredential(ctx, store.UpstreamCredentialInput{
		ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
		Models: models, Document: row.Document, Source: row.Source, ExpiresAt: row.ExpiresAt,
	})
	if err != nil {
		return row, "", err
	}
	if err = a.reloadNativeCredentials(ctx); err != nil {
		return row, "", err
	}
	return updated, source, nil
}

func (a *App) nativeProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Disabled *bool     `json:"disabled"`
		Name     *string   `json:"name"`
		Models   *[]string `json:"models"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Disabled == nil && input.Name == nil && input.Models == nil {
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
	name, models, enabled := row.Name, row.Models, row.Enabled
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
		if !row.Enabled {
			writeError(w, http.StatusConflict, "credential_disabled", "请先启用账户，再从 CPA 选择模型")
			return
		}
		if a.nativeCPARuntime == nil {
			writeError(w, http.StatusServiceUnavailable, "model_catalog_unavailable", "embedded CPA runtime is unavailable")
			return
		}
		models = uniqueStrings(*input.Models)
		if len(models) == 0 {
			writeError(w, http.StatusBadRequest, "validation_error", "至少选择一个 CPA 模型")
			return
		}
		candidates, _, discoverErr := a.nativeCPARuntime.DiscoverCredentialModels(r.Context(), row.ID)
		if discoverErr != nil && len(candidates) == 0 {
			writeError(w, http.StatusBadGateway, "model_catalog_unavailable", discoverErr.Error())
			return
		}
		allowedModels := make(map[string]struct{}, len(candidates))
		for _, candidate := range candidates {
			allowedModels[strings.ToLower(strings.TrimSpace(candidate))] = struct{}{}
		}
		for _, model := range models {
			if _, ok := allowedModels[strings.ToLower(model)]; !ok {
				writeError(w, http.StatusBadRequest, "model_not_in_cpa_catalog", "模型 "+model+" 不在 CPA 凭据目录中")
				return
			}
		}
		if len(candidates) == 0 {
			writeError(w, http.StatusBadGateway, "model_catalog_empty", "CPA 凭据目录为空")
			return
		}
	}
	row, err = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: row.ID, Name: name, Provider: row.Provider, Enabled: enabled, Models: models, Document: row.Document, Source: row.Source, ExpiresAt: row.ExpiresAt})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_update_failed", "更新 native 凭据失败")
		return
	}
	if err = a.reloadNativeCredentials(r.Context()); err != nil {
		_, _ = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: previous.ID, Name: previous.Name, Provider: previous.Provider, Enabled: previous.Enabled, Models: previous.Models, Document: previous.Document, Source: previous.Source, ExpiresAt: previous.ExpiresAt})
		_ = a.reloadNativeCredentials(r.Context())
		writeError(w, http.StatusBadRequest, "credential_invalid", err.Error())
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
	w.WriteHeader(http.StatusNoContent)
}
