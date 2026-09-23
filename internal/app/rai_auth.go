package app

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/google/uuid"
)

const raiAuthorizePath = "/rai/authorize/"

func raiAdapterNames() []string {
	return []string{"claude", "codex", "grok", "hermes", "opencode", "pi", "prime-agent"}
}

func (a *App) createRAIAuthorization(w http.ResponseWriter, r *http.Request) {
	var input struct {
		store.RAIDeviceMetadata
		DeviceName          string `json:"device_name"`
		CodeChallenge       string `json:"code_challenge"`
		CodeChallengeMethod string `json:"code_challenge_method"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	item, interval, err := a.store.CreateRAIAuthorization(r.Context(), input.DeviceName, input.CodeChallenge, input.CodeChallengeMethod, time.Now(), input.RAIDeviceMetadata)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	base := strings.TrimRight(a.cfg.PublicURL, "/")
	writeJSON(w, http.StatusCreated, map[string]any{
		"authorization_id": item.ID,
		"verification_uri": base + raiAuthorizePath + item.ID,
		"expires_in":       int(time.Until(item.ExpiresAt).Seconds()),
		"interval":         interval,
	})
}

func (a *App) raiToken(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AuthorizationID string `json:"authorization_id"`
		CodeVerifier    string `json:"code_verifier"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	plain, err := a.store.ConsumeRAIAuthorization(r.Context(), input.AuthorizationID, input.CodeVerifier)
	if err != nil {
		writeRAITokenError(w, err)
		return
	}
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"api_key":  plain,
		"api_base": a.cfg.PublicURL,
		"name":     "RelayAPI",
	})
}

func writeRAITokenError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrAuthorizationPending):
		writeError(w, http.StatusBadRequest, "authorization_pending", "等待批准")
	case errors.Is(err, store.ErrAuthorizationDenied):
		writeError(w, http.StatusForbidden, "access_denied", "授权已拒绝")
	case errors.Is(err, store.ErrAuthorizationExpired):
		writeError(w, http.StatusGone, "expired_token", "授权已过期")
	default:
		writeError(w, http.StatusBadRequest, "invalid_grant", "授权无效")
	}
}

// The public URL renders the shared frontend. Only this JSON API serves state.
func (a *App) raiAuthorization(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "授权请求不存在或已经失效")
		return
	}
	item, err := a.store.RAIAuthorization(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "授权请求不存在或已经失效")
		} else {
			writeError(w, http.StatusInternalServerError, "database_error", "无法读取授权请求，请重试")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": item.ID, "device_name": item.DeviceName, "device_os": item.DeviceOS,
		"device_arch": item.DeviceArch, "rai_version": item.RAIVersion,
		"status": item.Status, "expires_at": item.ExpiresAt,
	})
}

func (a *App) raiAuthorizeApprove(w http.ResponseWriter, r *http.Request) {
	a.completeRAIAuthorize(w, r, true)
}

func (a *App) raiAuthorizeDeny(w http.ResponseWriter, r *http.Request) {
	a.completeRAIAuthorize(w, r, false)
}

func (a *App) completeRAIAuthorize(w http.ResponseWriter, r *http.Request, approve bool) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "授权请求不存在或已经失效")
		return
	}
	tenantID := currentSession(r).TenantID
	var err error
	if approve {
		err = a.store.ApproveRAIAuthorization(r.Context(), id, tenantID)
	} else {
		err = a.store.DenyRAIAuthorization(r.Context(), id, tenantID)
	}
	if err != nil {
		writeRAITokenError(w, err)
		return
	}
	a.raiAuthorization(w, r)
}
