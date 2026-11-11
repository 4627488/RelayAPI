package app

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

type magpieQuotaWindow struct {
	Remaining float64   `json:"remaining"`
	ResetsAt  time.Time `json:"resets_at"`
}

type magpieBalanceDocument struct {
	BalanceUSD    float64                                 `json:"balance_usd"`
	Subscriptions map[string]map[string]magpieQuotaWindow `json:"subscriptions"`
}

// Stable object paths keep imported balance expressions valid when grants are reordered.
func magpieQuotaID(value string) string {
	var result strings.Builder
	result.WriteByte('q')
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			result.WriteRune(c)
		} else {
			result.WriteByte('_')
		}
	}
	return result.String()
}

func projectMagpieBalance(key store.KeyContext, quotas []store.SubscriptionQuota) (magpieBalanceDocument, string) {
	document := magpieBalanceDocument{BalanceUSD: float64(key.TenantBalance) / 1e9, Subscriptions: map[string]map[string]magpieQuotaWindow{}}
	paths := []string{"余额: $ balance_usd"}
	for _, quota := range quotas {
		id := magpieQuotaID(quota.ChildID)
		windows := map[string]magpieQuotaWindow{}
		for _, window := range quota.Windows {
			remaining := 0.0
			if window.LimitNanoUSD > 0 {
				remaining = max(0, min(1, 1-float64(window.SettledNanoUSD)/float64(window.LimitNanoUSD)-float64(window.ReservedNanoUSD)/float64(window.LimitNanoUSD)))
			}
			kind := magpieQuotaID(window.Kind)
			windows[kind] = magpieQuotaWindow{Remaining: remaining, ResetsAt: window.ResetsAt}
			label := strings.Map(func(c rune) rune {
				if strings.ContainsRune(";:$¥%\r\n", c) {
					return ' '
				}
				return c
			}, quota.Name+" "+window.Kind+" 剩余")
			paths = append(paths, label+": subscriptions."+id+"."+kind+".remaining %")
		}
		document.Subscriptions[id] = windows
	}
	return document, strings.Join(paths, "; ")
}

func (a *App) magpieQuotas(r *http.Request, key store.KeyContext) ([]store.SubscriptionQuota, error) {
	var models []string
	if a.nativeRuntime != nil {
		models = a.nativeRuntime.Models()
	}
	return a.store.SubscriptionQuotas(r.Context(), key, models, time.Now())
}

func (a *App) magpieBalance(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	key, err := a.store.ResolveKey(r.Context(), bearer(r))
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	quotas, err := a.magpieQuotas(r, key)
	if err != nil {
		writeError(w, 500, "quota_unavailable", "额度查询失败")
		return
	}
	document, _ := projectMagpieBalance(key, quotas)
	writeJSON(w, http.StatusOK, document)
}

func (a *App) magpieImport(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	plain, err := a.store.RevealKey(r.Context(), currentSession(r).TenantID, r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "not_found", "密钥不存在或无法恢复，请创建新密钥")
		return
	}
	key, err := a.store.ResolveKey(r.Context(), plain)
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, 401, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	quotas, err := a.magpieQuotas(r, key)
	if err != nil {
		writeError(w, 500, "quota_unavailable", "额度查询失败")
		return
	}
	_, path := projectMagpieBalance(key, quotas)
	writeJSON(w, http.StatusOK, map[string]string{"href": magpieImportURL(a.cfg.PublicURL, plain, path)})
}

func magpieImportURL(publicURL, plain, balancePath string) string {
	base := strings.TrimRight(publicURL, "/")
	u, _ := url.Parse(base)
	params := url.Values{
		"name": {"RelayAPI"}, "chat": {base + "/v1"}, "responses": {base + "/v1"},
		"anthropic": {base}, "gemini": {base + "/v1beta"}, "key": {plain},
	}
	if u != nil {
		params.Set("name", "RelayAPI · "+u.Hostname())
	}
	// Magpie requires HTTPS for balance and website URLs, including local installs.
	if strings.HasPrefix(base, "https://") {
		params.Set("website", base)
		params.Set("keys", base+"/app/keys")
		params.Set("balance", base+"/api/magpie/balance")
		params.Set("balance_path", balancePath)
	}
	return "https://usemagpie.ai/import#" + params.Encode()
}
