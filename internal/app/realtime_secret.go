package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const realtimeSecretPrefix = "relay_realtime_"
const realtimeSecretAAD = "relayapi/realtime-client-secret/v1"
const realtimeOriginContext contextKey = "realtime_origin"
const realtimeAuthContext contextKey = "realtime_auth"
const runtimePrincipalContext contextKey = "runtime_principal"

type realtimeAuthorization struct {
	RelayKey  string `json:"key"`
	CPAToken  string `json:"token"`
	Model     string `json:"model"`
	ExpiresAt int64  `json:"exp"`
}

func isRealtimeSecretCreation(path string) bool {
	return path == "/v1/realtime/client_secrets" || path == "/v1/realtime/sessions"
}

func realtimeSecretCanAccess(path string) bool {
	return path == "/v1/realtime" || path == "/v1/realtime/calls" || strings.HasPrefix(path, "/v1/realtime/calls/")
}

// The CPA secret scopes the realtime session; the encrypted Relay envelope
// also binds it to its issuing key. Every use rechecks that key's current
// tenant, expiry, model policy and subscription rather than caching authority.
func (a *App) openRealtimeSecret(token string, now time.Time) (realtimeAuthorization, error) {
	var authorization realtimeAuthorization
	if !strings.HasPrefix(token, realtimeSecretPrefix) || len(token) > 16<<10 {
		return authorization, errors.New("invalid realtime client secret")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, realtimeSecretPrefix))
	if err != nil {
		return authorization, err
	}
	plain, err := a.setupBox.Open(sealed, realtimeSecretAAD)
	if err != nil {
		return authorization, err
	}
	defer clear(plain)
	if err := json.Unmarshal(plain, &authorization); err != nil {
		return authorization, err
	}
	if authorization.RelayKey == "" || authorization.CPAToken == "" || authorization.Model == "" || now.Unix() >= authorization.ExpiresAt {
		return realtimeAuthorization{}, errors.New("expired or invalid realtime client secret")
	}
	return authorization, nil
}

func (a *App) wrapRealtimeSecret(payload []byte, origin realtimeAuthorization) ([]byte, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	secret := document
	legacy := len(document["client_secret"]) > 0
	if legacy {
		secret = make(map[string]json.RawMessage)
		if err := json.Unmarshal(document["client_secret"], &secret); err != nil {
			return nil, err
		}
	}
	if err := json.Unmarshal(secret["value"], &origin.CPAToken); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(secret["expires_at"], &origin.ExpiresAt); err != nil {
		return nil, err
	}
	if origin.RelayKey == "" || origin.Model == "" || origin.CPAToken == "" || origin.ExpiresAt <= time.Now().Unix() {
		return nil, errors.New("invalid realtime client secret response")
	}
	plain, err := json.Marshal(origin)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	sealed, err := a.setupBox.Seal(plain, realtimeSecretAAD)
	if err != nil {
		return nil, err
	}
	secret["value"], _ = json.Marshal(realtimeSecretPrefix + base64.RawURLEncoding.EncodeToString(sealed))
	if legacy {
		document["client_secret"], _ = json.Marshal(secret)
	}
	return json.Marshal(document)
}

func runtimeAuthorizationToken(ctx context.Context, internalKey string) string {
	if authorization, ok := ctx.Value(realtimeAuthContext).(realtimeAuthorization); ok {
		return authorization.CPAToken
	}
	return internalKey
}
