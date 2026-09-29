package app

import (
	"net/http"
	"sort"
	"time"

	"github.com/4627488/RelayAPI/internal/rai"
	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) raiDiscovery(w http.ResponseWriter, _ *http.Request) {
	document := map[string]any{
		"name":             "RelayAPI",
		"kind":             "rai.dev/v1",
		"api_base":         a.cfg.PublicURL,
		"models":           "/v1/models",
		"health":           "/healthz",
		"session":          "/api/rai/session",
		"authorization":    "/api/rai/authorizations",
		"token":            "/api/rai/token",
		"authorize":        "/rai/authorize",
		"install":          "/rai/install.sh",
		"download":         "/rai/download",
		"adapters":         raiAdapterNames(),
		"contract_version": "1",
		"min_rai_version":  "0.1.0",
	}
	if version := a.raiBundledVersion(); version != "" {
		document["rai_version"] = version
	}
	writeJSON(w, http.StatusOK, document)
}

func (a *App) raiSession(w http.ResponseWriter, r *http.Request) {
	key, err := a.store.ResolveKey(r.Context(), bearer(r))
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	models := a.raiSessionModels(r, key)
	defaultModel := rai.SelectDefaultModel(models, a.currentNativeSettings().RAIDefaultModels)
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"contract_version": "1",
		"name":             "RelayAPI",
		"api_base":         a.cfg.PublicURL,
		"models":           models,
		"default_model":    defaultModel,
		"adapters":         raiAdapterNames(),
	})
}

func (a *App) raiQuota(w http.ResponseWriter, r *http.Request) {
	key, err := a.store.ResolveKey(r.Context(), bearer(r))
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	models := []string(nil)
	if a.nativeRuntime != nil {
		models = a.nativeRuntime.Models()
	}
	items, err := a.store.SubscriptionQuotas(r.Context(), key, models, time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "quota_unavailable", "额度查询失败")
		return
	}
	setSensitiveNoStore(w)
	type quotaWindow struct {
		Kind            string    `json:"kind"`
		LimitNanoUSD    int64     `json:"limit_nano_usd"`
		SettledNanoUSD  int64     `json:"settled_nano_usd"`
		ReservedNanoUSD int64     `json:"reserved_nano_usd"`
		ResetsAt        time.Time `json:"resets_at"`
	}
	type quotaItem struct {
		Name     string        `json:"name"`
		Provider string        `json:"provider"`
		Windows  []quotaWindow `json:"windows"`
	}
	result := make([]quotaItem, 0, len(items))
	for _, item := range items {
		entry := quotaItem{Name: item.Name, Provider: item.Provider, Windows: make([]quotaWindow, 0, len(item.Windows))}
		for _, window := range item.Windows {
			entry.Windows = append(entry.Windows, quotaWindow{
				Kind: window.Kind, LimitNanoUSD: window.LimitNanoUSD,
				SettledNanoUSD: window.SettledNanoUSD, ReservedNanoUSD: window.ReservedNanoUSD,
				ResetsAt: window.ResetsAt,
			})
		}
		result = append(result, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": result})
}

func (a *App) raiSessionModels(r *http.Request, key store.KeyContext) []string {
	models, err := a.agentSetupModels(r.Context(), key.TenantID, bearer(r))
	if err == nil && len(models) > 0 {
		sort.Strings(models)
		return models
	}
	if a.nativeRuntime == nil {
		return nil
	}
	out := make([]string, 0)
	for _, model := range a.nativeRuntime.Models() {
		if key.AllowsModel(model) {
			out = append(out, model)
		}
	}
	sort.Strings(out)
	return out
}
