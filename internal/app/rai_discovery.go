package app

import (
	"net/http"
	"time"

	"github.com/4627488/RelayAPI/internal/pricing"
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
		"contract_version": "2",
		"min_rai_version":  "0.3.0",
		"revocation":       "/api/rai/revoke",
		"auth_methods":     []string{"device_pkce", "refresh_token", "api_key"},
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
	models := a.raiSessionModels(key)
	defaultModel := rai.SelectDefaultModel(models, a.currentNativeSettings().RAIDefaultModels)
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"contract_version": "2",
		"name":             "RelayAPI",
		"api_base":         a.cfg.PublicURL,
		"models":           models,
		"model_info":       a.raiModelInfo(key, models),
		"default_model":    defaultModel,
		"codex":            a.raiCodexCapabilities(key, models),
		"adapters":         raiAdapterNames(),
	})
}

func (a *App) raiModelInfo(key store.KeyContext, models []string) map[string]rai.ModelInfo {
	index := a.capabilityIndex()
	result := make(map[string]rai.ModelInfo, len(models))
	for _, id := range models {
		target := resolveAPIKeyModel(id, key.ModelAliases).Model
		info := rai.ModelInfo{}
		if fact, ok := index.LookupCatalog(target); ok && trustedCodexCapability(target, fact) {
			applyRAIModelInfo(&info, fact)
		}
		if override, ok := index.LookupOverride(target); ok {
			applyRAIModelInfo(&info, override)
		}
		result[id] = info
	}
	return result
}

func applyRAIModelInfo(info *rai.ModelInfo, fact pricing.Capability) {
	if fact.Name != "" {
		info.Name = fact.Name
	}
	if fact.Context > 0 {
		info.Context = fact.Context
	}
	if fact.MaxInput > 0 {
		info.MaxInput = fact.MaxInput
	}
	if fact.MaxOutput > 0 {
		info.MaxOutput = fact.MaxOutput
	}
	if fact.ToolCall != nil {
		info.ToolCall = fact.ToolCall
	}
	if len(fact.InputModalities) > 0 {
		info.InputModalities = fact.InputModalities
	}
	if len(fact.OutputModalities) > 0 {
		info.OutputModalities = fact.OutputModalities
	}
	if fact.Source != pricing.SourceAdmin || len(fact.ReasoningOptions) > 0 {
		reasoning := fact.Reasoning
		info.Reasoning = &reasoning
		info.ReasoningLevels = fact.EffortValues()
	}
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

func (a *App) raiSessionModels(key store.KeyContext) []string {
	if a.nativeRuntime == nil {
		return nil
	}
	return visibleClientModels(key, a.nativeRuntime.Models())
}
