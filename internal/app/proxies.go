package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
)

const proxyTestURL = "https://ipwho.is/"

type proxyView struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Endpoint   string    `json:"endpoint"`
	Scheme     string    `json:"scheme"`
	Host       string    `json:"host"`
	AccountUse int64     `json:"account_use"`
	SystemUse  bool      `json:"system_use"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func (a *App) adminProxies(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var input struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := cpa.ValidateProxyURL(input.URL); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_proxy_url", err.Error())
			return
		}
		item, err := a.store.CreateOutboundProxy(r.Context(), input.Name, input.URL)
		if err != nil {
			writeError(w, http.StatusBadRequest, "proxy_create_failed", boundedErrorText(err.Error()))
			return
		}
		writeJSON(w, http.StatusCreated, a.proxyView(r.Context(), item))
		return
	}
	items, err := a.store.ListOutboundProxies(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "proxy_list_failed", "无法读取代理列表")
		return
	}
	views := make([]proxyView, 0, len(items))
	for _, item := range items {
		views = append(views, a.proxyView(r.Context(), item))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views})
}

func (a *App) adminProxy(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if r.Method == http.MethodDelete {
		a.nativeSettings.RLock()
		systemProxyID := a.nativeSettings.value.SystemProxyID
		a.nativeSettings.RUnlock()
		if systemProxyID == id {
			writeError(w, http.StatusConflict, "proxy_in_use", "该代理仍被系统设置使用，请先取消选择")
			return
		}
		if err := a.store.DeleteOutboundProxy(r.Context(), id); err != nil {
			status := http.StatusConflict
			if errors.Is(err, store.ErrNotFound) {
				status = http.StatusNotFound
			}
			writeError(w, status, "proxy_delete_failed", boundedErrorText(err.Error()))
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	current, err := a.store.GetOutboundProxy(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "proxy_not_found", "代理不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "proxy_unavailable", "无法读取代理")
		return
	}
	var input struct {
		Name *string `json:"name"`
		URL  *string `json:"url"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	name, rawURL := current.Name, current.URL
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	if input.URL != nil && strings.TrimSpace(*input.URL) != "" {
		rawURL = strings.TrimSpace(*input.URL)
	}
	if name == "" {
		writeError(w, http.StatusBadRequest, "invalid_proxy_name", "代理名称不能为空")
		return
	}
	if err := cpa.ValidateProxyURL(rawURL); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_proxy_url", err.Error())
		return
	}
	item, err := a.store.UpdateOutboundProxy(r.Context(), id, name, rawURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "proxy_update_failed", boundedErrorText(err.Error()))
		return
	}
	if a.nativeRuntime != nil {
		a.nativeSettings.RLock()
		settings := a.nativeSettings.value
		a.nativeSettings.RUnlock()
		if settings.SystemProxyID == id {
			err = a.nativeRuntime.ApplySettings(r.Context(), runtimeBridgeSettings(settings, item.URL))
		}
		if err == nil {
			err = a.reloadNativeCredentials(r.Context())
		}
		if err != nil {
			_, _ = a.store.UpdateOutboundProxy(r.Context(), current.ID, current.Name, current.URL)
			if settings.SystemProxyID == id {
				_ = a.nativeRuntime.ApplySettings(r.Context(), runtimeBridgeSettings(settings, current.URL))
			}
			_ = a.reloadNativeCredentials(r.Context())
			writeError(w, http.StatusBadGateway, "proxy_reload_failed", err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, a.proxyView(r.Context(), item))
}

func (a *App) adminProxyTest(w http.ResponseWriter, r *http.Request) {
	item, err := a.store.GetOutboundProxy(r.Context(), strings.TrimSpace(r.PathValue("id")))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "proxy_not_found", "代理不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "proxy_unavailable", "无法读取代理")
		return
	}
	client, err := cpa.OutboundHTTPClient(item.URL, 15*time.Second)
	if err != nil {
		writeError(w, http.StatusBadRequest, "proxy_invalid", err.Error())
		return
	}
	started := time.Now()
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, proxyTestURL, nil)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "RelayAPI proxy-check")
	response, err := client.Do(request)
	latency := time.Since(started)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "latency_ms": latency.Milliseconds(), "error": boundedErrorText(err.Error())})
		return
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, 256<<10))
	if readErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "latency_ms": latency.Milliseconds(), "status": response.StatusCode, "error": "出口信息服务请求失败"})
		return
	}
	var result struct {
		Success bool   `json:"success"`
		IP      string `json:"ip"`
		Type    string `json:"type"`
		City    string `json:"city"`
		Region  string `json:"region"`
		Country string `json:"country"`
		Flag    struct {
			Emoji string `json:"emoji"`
		} `json:"flag"`
		Connection struct {
			ASN    int64  `json:"asn"`
			Org    string `json:"org"`
			ISP    string `json:"isp"`
			Domain string `json:"domain"`
		} `json:"connection"`
	}
	if err = json.Unmarshal(payload, &result); err != nil || !result.Success || strings.TrimSpace(result.IP) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "latency_ms": latency.Milliseconds(), "error": "出口信息服务返回了无效数据"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "latency_ms": latency.Milliseconds(), "ip": result.IP, "ip_type": result.Type,
		"city": result.City, "region": result.Region, "country": result.Country, "flag": result.Flag.Emoji,
		"asn": result.Connection.ASN, "organization": firstNonEmptyString(result.Connection.Org, result.Connection.ISP),
		"isp": result.Connection.ISP, "domain": result.Connection.Domain,
	})
}

func (a *App) proxyView(ctx context.Context, item store.OutboundProxy) proxyView {
	parsed, _ := url.Parse(item.URL)
	accountUse, _ := a.store.CountOutboundProxyReferences(ctx, item.ID)
	a.nativeSettings.RLock()
	systemUse := a.nativeSettings.value.SystemProxyID == item.ID
	a.nativeSettings.RUnlock()
	return proxyView{ID: item.ID, Name: item.Name, Endpoint: cpa.RedactProxyURL(item.URL), Scheme: parsed.Scheme, Host: parsed.Host, AccountUse: accountUse, SystemUse: systemUse, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func (a *App) proxyURL(ctx context.Context, id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", nil
	}
	item, err := a.store.GetOutboundProxy(ctx, id)
	if err != nil {
		return "", err
	}
	return item.URL, nil
}

func (a *App) validProxyID(ctx context.Context, id string) (*string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil
	}
	if _, err := a.store.GetOutboundProxy(ctx, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, errors.New("选择的代理不存在")
		}
		return nil, err
	}
	return &id, nil
}

func (a *App) systemProxyURL(ctx context.Context) (string, error) {
	a.nativeSettings.RLock()
	id := a.nativeSettings.value.SystemProxyID
	a.nativeSettings.RUnlock()
	return a.proxyURL(ctx, id)
}

func (a *App) proxyURLs(ctx context.Context) (map[string]string, error) {
	items, err := a.store.ListOutboundProxies(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]string, len(items))
	for _, item := range items {
		result[item.ID] = item.URL
	}
	return result, nil
}

func (a *App) migrateLegacyProxies(ctx context.Context, rows []store.UpstreamCredentialSnapshot, settings *nativeRuntimeSettings, legacyGlobal string) (bool, error) {
	items, err := a.store.ListOutboundProxies(ctx)
	if err != nil {
		return false, err
	}
	byURL, usedNames := make(map[string]string, len(items)), make(map[string]struct{}, len(items))
	for _, item := range items {
		byURL[strings.TrimSpace(item.URL)] = item.ID
		usedNames[strings.ToLower(item.Name)] = struct{}{}
	}
	ensure := func(raw, label string) (*string, error) {
		raw = strings.TrimSpace(raw)
		if raw == "" || strings.EqualFold(raw, "direct") || strings.EqualFold(raw, "none") {
			return nil, nil
		}
		if err := cpa.ValidateProxyURL(raw); err != nil {
			return nil, err
		}
		if id := byURL[raw]; id != "" {
			return &id, nil
		}
		name := strings.TrimSpace(label)
		if parsed, parseErr := url.Parse(raw); name == "" && parseErr == nil {
			name = "迁移代理 " + parsed.Host
		}
		if name == "" {
			name = "迁移代理"
		}
		base := name
		for suffix := 2; ; suffix++ {
			if _, exists := usedNames[strings.ToLower(name)]; !exists {
				break
			}
			name = fmt.Sprintf("%s %d", base, suffix)
		}
		created, createErr := a.store.CreateOutboundProxy(ctx, name, raw)
		if createErr != nil {
			return nil, createErr
		}
		byURL[raw], usedNames[strings.ToLower(name)] = created.ID, struct{}{}
		return &created.ID, nil
	}

	changed := false
	legacyGlobal = strings.TrimSpace(legacyGlobal)
	if settings.SystemProxyID == "" {
		if id, ensureErr := ensure(legacyGlobal, "迁移的系统代理"); ensureErr != nil {
			return false, ensureErr
		} else if id != nil {
			settings.SystemProxyID, changed = *id, true
		}
	}
	for _, row := range rows {
		var document map[string]any
		if err = json.Unmarshal(row.Document, &document); err != nil {
			return false, err
		}
		raw, hasExplicit := document["proxy_url"].(string)
		if strings.TrimSpace(raw) == "" {
			hasExplicit = false
			if legacy, ok := document["_relay_proxy_url"].(string); ok && strings.TrimSpace(legacy) != "" {
				raw, hasExplicit = legacy, true
			}
		}
		if !hasExplicit && row.ProxyID == nil {
			raw = legacyGlobal
		}
		delete(document, "proxy_url")
		delete(document, "_relay_proxy_url")
		proxyID := row.ProxyID
		if proxyID == nil {
			proxyID, err = ensure(raw, "迁移的账户代理")
			if err != nil {
				return false, fmt.Errorf("migrate proxy for credential %q: %w", row.ID, err)
			}
		}
		encoded, _ := json.Marshal(document)
		if string(encoded) == string(row.Document) && equalOptionalString(proxyID, row.ProxyID) {
			continue
		}
		if _, err = a.store.UpsertUpstreamCredential(ctx, store.UpstreamCredentialInput{
			ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled, Models: row.Models,
			Document: encoded, Source: row.Source, ProxyID: proxyID, ExpiresAt: row.ExpiresAt,
		}); err != nil {
			return false, err
		}
		changed = true
	}
	return changed, nil
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
