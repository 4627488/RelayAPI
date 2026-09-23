package app

import (
	"errors"
	"net/http"

	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) raiDevices(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListRAIDevices(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", "无法读取 rai 已登录设备")
		return
	}
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) revokeRAIDevice(w http.ResponseWriter, r *http.Request) {
	err := a.store.RevokeRAIDevice(r.Context(), currentSession(r).TenantID, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "设备不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", "无法撤销设备登录")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
