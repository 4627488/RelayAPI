package app

import (
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
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
		input.Name = strings.TrimSpace(input.Name)
		if input.Provider == "" || input.Name == "" || len(input.Models) == 0 || !json.Valid(input.Document) {
			writeError(w, http.StatusBadRequest, "validation_error", "名称、提供商、至少一个模型和有效凭据 JSON 均为必填项")
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
		row, err := a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: id, Name: input.Name, Provider: input.Provider, Enabled: enabled, Models: uniqueStrings(input.Models), Document: input.Document, Source: "native"})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "credential_save_failed", "保存凭据失败")
			return
		}
		if err = a.reloadNativeCredentials(r.Context()); err != nil {
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
	return map[string]any{"id": row.ID, "auth_index": row.ID, "name": row.ID, "label": row.Name, "provider": row.Provider, "type": row.Provider,
		"email": email, "disabled": !row.Enabled, "unavailable": expired, "status": "native", "source": "native", "models": row.Models,
		"base_url": baseURL, "prefix": prefix, "proxy_configured": strings.TrimSpace(proxyURL) != "", "revision": row.Revision,
		"can_inspect": true, "can_toggle": true, "can_delete": true}
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
	writeJSON(w, http.StatusOK, map[string]any{"models": row.Models})
}

func (a *App) nativeProviderAccountUpdate(w http.ResponseWriter, r *http.Request) {
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
	row, err = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: !*input.Disabled, Models: row.Models, Document: row.Document, Source: row.Source, ExpiresAt: row.ExpiresAt})
	if err != nil || a.reloadNativeCredentials(r.Context()) != nil {
		writeError(w, http.StatusInternalServerError, "credential_update_failed", "更新 native 凭据失败")
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
