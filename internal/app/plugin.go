package app

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
)

func (a *App) cpaPluginUsage(w http.ResponseWriter, r *http.Request) {
	if a.cfg.CPAPluginSecret == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Relay-Plugin-Secret")), []byte(a.cfg.CPAPluginSecret)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "无效的插件凭据")
		return
	}
	var record map[string]any
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := decoder.Decode(&record); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "用量事件无效")
		return
	}
	// CPA v7's usage ABI does not expose Relay's request correlation header.
	// Keep this event as credential/failure telemetry; request settlement remains
	// driven by the correlated response parsed in proxy.go.
	slog.Info("CPA usage event", "provider", record["Provider"], "model", record["Model"],
		"auth_id", record["AuthID"], "failed", record["Failed"])
	w.WriteHeader(http.StatusNoContent)
}
