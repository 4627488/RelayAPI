package app

import (
	"context"
	"net/http"
	"strings"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

type raiManagementContextKey struct{}

// This middleware is used only by the explicit user-management route allowlist.
// It cannot authenticate browser, administrator, or inference endpoints.
func (a *App) withRAIManagement(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSensitiveNoStore(w)
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeError(w, 401, "unauthorized", "Run rai account login to authorize account management.")
			return
		}
		grant, err := a.store.RAIOAuthSession(r.Context(), strings.TrimPrefix(header, "Bearer "))
		if err != nil || grant.Purpose != "account" {
			writeError(w, 401, "unauthorized", "Account authorization expired or was revoked. Run rai account login.")
			return
		}
		session := identity.Session{Role: "tenant", TenantID: grant.TenantID, PasswordVersion: grant.PasswordVersion, Expires: grant.ExpiresAt.Unix()}
		ctx := context.WithValue(r.Context(), sessionKey, session)
		ctx = context.WithValue(ctx, raiManagementContextKey{}, grant)
		next(w, r.WithContext(ctx))
	})
}

func (a *App) raiManagementSession(w http.ResponseWriter, r *http.Request) {
	grant := r.Context().Value(raiManagementContextKey{}).(db.RAIOAuthSession)
	if r.Method == http.MethodDelete {
		if err := a.store.RevokeRAIOAuthSession(r.Context(), grant.TenantID, grant.ID); err != nil {
			writeError(w, 500, "revoke_failed", "Could not revoke account authorization.")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, 200, grant)
}

func (a *App) raiManagementKey(w http.ResponseWriter, r *http.Request) {
	if err := a.store.IsManualKey(r.Context(), currentSession(r).TenantID, r.PathValue("id")); err != nil {
		writeError(w, 404, "not_found", "Key does not exist.")
		return
	}
	if r.Method == http.MethodDelete {
		a.keyDelete(w, r)
	} else {
		a.keyUpdate(w, r)
	}
}

func (a *App) raiManagementRoutes() {
	for pattern, handler := range map[string]http.HandlerFunc{
		"GET /api/rai/manage/session":         a.raiManagementSession,
		"DELETE /api/rai/manage/session":      a.raiManagementSession,
		"GET /api/rai/manage/account":         a.me,
		"GET /api/rai/manage/keys":            a.keys,
		"POST /api/rai/manage/keys":           a.keys,
		"PUT /api/rai/manage/keys/{id}":       a.raiManagementKey,
		"DELETE /api/rai/manage/keys/{id}":    a.raiManagementKey,
		"GET /api/rai/manage/quota":           a.tenantSubscriptions,
		"GET /api/rai/manage/usage":           a.usage,
		"GET /api/rai/manage/devices":         a.raiDevices,
		"DELETE /api/rai/manage/devices/{id}": a.revokeRAIDevice,
	} {
		a.mux.Handle(pattern, a.withRAIManagement(handler))
	}
}
