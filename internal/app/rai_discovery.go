package app

import (
	"net/http"
	"sort"

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
	if err != nil || !key.Enabled || !key.TenantEnabled {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	if expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "api_key_expired", "API Key 已过期，请在控制台续期后再试")
		return
	}
	models := a.raiSessionModels(r, key)
	defaultModel := ""
	if len(models) > 0 {
		defaultModel = models[0]
	}
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
