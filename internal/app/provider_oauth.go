package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

const providerOAuthSessionTTL = 30 * time.Minute

type providerOAuthSession struct {
	ID                 string
	State              string
	Provider           string
	TargetCredentialID string
	Label              string
	Email              string
	Document           []byte
	CreatedAt          time.Time
	ExpiresAt          time.Time
	Error              string
}

type providerOAuthSessions struct {
	mu      sync.Mutex
	byState map[string]*providerOAuthSession
	byID    map[string]*providerOAuthSession
}

func newProviderOAuthSessions() providerOAuthSessions {
	return providerOAuthSessions{byState: make(map[string]*providerOAuthSession), byID: make(map[string]*providerOAuthSession)}
}

func (s *providerOAuthSessions) purgeLocked(now time.Time) {
	for id, session := range s.byID {
		if now.After(session.ExpiresAt) {
			clear(session.Document)
			delete(s.byID, id)
			delete(s.byState, session.State)
		}
	}
}

func (s *providerOAuthSessions) create(provider, targetCredentialID string) *providerOAuthSession {
	now := time.Now()
	session := &providerOAuthSession{
		ID: nativeCredentialID("oauth"), Provider: provider,
		TargetCredentialID: strings.TrimSpace(targetCredentialID),
		CreatedAt:          now, ExpiresAt: now.Add(providerOAuthSessionTTL),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeLocked(now)
	s.byID[session.ID] = session
	return session
}

func (s *providerOAuthSessions) bindState(id, state string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.byID[id]
	if session == nil {
		return false
	}
	session.State = state
	s.byState[state] = session
	return true
}

func (s *providerOAuthSessions) snapshotByState(state string) (providerOAuthSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeLocked(time.Now())
	session := s.byState[state]
	if session == nil {
		return providerOAuthSession{}, false
	}
	copySession := *session
	copySession.Document = append([]byte(nil), session.Document...)
	return copySession, true
}

func (s *providerOAuthSessions) capture(id, provider, label string, document []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeLocked(time.Now())
	session := s.byID[id]
	if session == nil {
		return fmt.Errorf("Relay OAuth session expired")
	}
	if normalizedOAuthProvider(provider) != session.Provider {
		return fmt.Errorf("OAuth provider does not match the Relay session")
	}
	var metadata map[string]any
	if err := json.Unmarshal(document, &metadata); err != nil {
		return fmt.Errorf("decode OAuth credential: %w", err)
	}
	clear(session.Document)
	session.Document = append([]byte(nil), document...)
	session.Label = strings.TrimSpace(label)
	if email, _ := metadata["email"].(string); strings.TrimSpace(email) != "" {
		session.Email = strings.TrimSpace(email)
	}
	return nil
}

func (s *providerOAuthSessions) setError(state, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session := s.byState[state]; session != nil {
		session.Error = strings.TrimSpace(message)
	}
}

func (s *providerOAuthSessions) remove(state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.byState[state]
	if session == nil {
		return
	}
	clear(session.Document)
	delete(s.byState, state)
	delete(s.byID, session.ID)
}

func (s *providerOAuthSessions) removeByID(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.byID[id]
	if session == nil {
		return
	}
	clear(session.Document)
	delete(s.byID, id)
	delete(s.byState, session.State)
}

func normalizedOAuthProvider(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic", "claude":
		return "claude"
	case "openai", "codex":
		return "codex"
	case "grok", "x.ai", "xai":
		return "xai"
	default:
		return strings.ToLower(strings.TrimSpace(provider))
	}
}

func supportsProviderOAuth(provider string) bool {
	switch normalizedOAuthProvider(provider) {
	case "codex", "claude", "antigravity", "kimi", "xai":
		return true
	default:
		return false
	}
}

func (a *App) captureProviderOAuthCredential(_ context.Context, sessionID, provider, label string, document []byte) error {
	return a.providerOAuth.capture(sessionID, provider, label, document)
}

func (a *App) adminProviderOAuthStart(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Provider     string `json:"provider"`
		CredentialID string `json:"credential_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	provider := normalizedOAuthProvider(input.Provider)
	if !supportsProviderOAuth(provider) {
		writeError(w, http.StatusBadRequest, "oauth_unsupported", "该提供商暂不支持 OAuth 连接")
		return
	}
	if a.nativeCPARuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "oauth_unavailable", "OAuth 连接服务暂不可用")
		return
	}
	credentialID := strings.TrimSpace(input.CredentialID)
	if credentialID != "" {
		row, err := a.store.GetUpstreamCredential(r.Context(), credentialID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "credential_not_found", "要重新认证的账户不存在")
			} else {
				writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法读取要重新认证的账户")
			}
			return
		}
		var document map[string]any
		_ = json.Unmarshal(row.Document, &document)
		if nativeCredentialAuthKind(document, row.Source) != "oauth" {
			writeError(w, http.StatusBadRequest, "reauth_unsupported", "只有 OAuth 账户可以重新认证")
			return
		}
		if normalizedOAuthProvider(row.Provider) != provider {
			writeError(w, http.StatusBadRequest, "provider_mismatch", "重新认证的提供商与原账户不一致")
			return
		}
	}
	session := a.providerOAuth.create(provider, credentialID)
	result, err := a.nativeCPARuntime.StartOAuth(r.Context(), provider, session.ID)
	if err != nil {
		a.providerOAuth.removeByID(session.ID)
		writeError(w, http.StatusBadGateway, "oauth_start_failed", err.Error())
		return
	}
	if strings.TrimSpace(result.State) == "" || strings.TrimSpace(result.URL) == "" || !a.providerOAuth.bindState(session.ID, result.State) {
		a.providerOAuth.removeByID(session.ID)
		writeError(w, http.StatusBadGateway, "oauth_start_failed", "授权服务未返回有效会话")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (a *App) adminProviderOAuthStatus(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.PathValue("state"))
	session, ok := a.providerOAuth.snapshotByState(state)
	if !ok {
		writeError(w, http.StatusNotFound, "oauth_session_not_found", "授权会话不存在或已过期")
		return
	}
	if session.Error != "" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "error", "error": session.Error})
		return
	}
	if len(session.Document) > 0 {
		result := map[string]any{"status": "authorized", "provider": session.Provider}
		if session.Email != "" {
			result["email"] = session.Email
		}
		if session.Label != "" {
			result["suggested_name"] = session.Label
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	status, err := a.nativeCPARuntime.OAuthStatus(r.Context(), state)
	if err != nil {
		a.providerOAuth.setError(state, err.Error())
		writeJSON(w, http.StatusOK, map[string]any{"status": "error", "error": err.Error()})
		return
	}
	if status.Status == "ok" {
		// The credential capture happens synchronously before CPA marks the session complete.
		if latest, found := a.providerOAuth.snapshotByState(state); found && len(latest.Document) > 0 {
			a.adminProviderOAuthStatus(w, r)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "waiting"})
}

func (a *App) adminProviderOAuthCallback(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.PathValue("state"))
	session, ok := a.providerOAuth.snapshotByState(state)
	if !ok {
		writeError(w, http.StatusNotFound, "oauth_session_not_found", "授权会话不存在或已过期")
		return
	}
	var input struct {
		RedirectURL string `json:"redirect_url"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.RedirectURL) == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "请粘贴授权完成后的回调地址")
		return
	}
	if err := a.nativeCPARuntime.SubmitOAuthCallback(r.Context(), session.Provider, state, strings.TrimSpace(input.RedirectURL)); err != nil {
		writeError(w, http.StatusBadRequest, "oauth_callback_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "waiting"})
}

func (a *App) adminProviderOAuthFinalize(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.PathValue("state"))
	session, ok := a.providerOAuth.snapshotByState(state)
	if !ok {
		writeError(w, http.StatusNotFound, "oauth_session_not_found", "授权会话不存在或已过期")
		return
	}
	if len(session.Document) == 0 {
		writeError(w, http.StatusConflict, "oauth_not_authorized", "账户授权尚未完成")
		return
	}
	var input struct {
		Name    string  `json:"name"`
		ProxyID *string `json:"proxy_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var previous *store.UpstreamCredentialSnapshot
	if session.TargetCredentialID != "" {
		row, err := a.store.GetUpstreamCredential(r.Context(), session.TargetCredentialID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "credential_not_found", "原 OAuth 账户已不存在")
			} else {
				writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法读取原 OAuth 账户")
			}
			return
		}
		if normalizedOAuthProvider(row.Provider) != session.Provider {
			writeError(w, http.StatusConflict, "provider_mismatch", "原账户提供商已发生变化")
			return
		}
		previous = &row
	}
	name := strings.TrimSpace(input.Name)
	if name == "" && previous != nil {
		name = previous.Name
	}
	if name == "" {
		name = strings.TrimSpace(session.Email)
	}
	if name == "" {
		name = strings.TrimSpace(session.Label)
	}
	if name == "" {
		writeError(w, http.StatusBadRequest, "validation_error", "账户名称必填")
		return
	}
	id := nativeCredentialID(session.Provider)
	document := json.RawMessage(session.Document)
	enabled := true
	models := []string(nil)
	var expiresAt *time.Time
	if previous != nil {
		id = previous.ID
		enabled = previous.Enabled
		models = previous.Models
		expiresAt = previous.ExpiresAt
		var mergeErr error
		document, mergeErr = mergeOAuthCredentialSettings(previous.Document, document)
		if mergeErr != nil {
			writeError(w, http.StatusInternalServerError, "credential_merge_failed", "合并 OAuth 账户设置失败")
			return
		}
	}
	proxyID := optionalProxyID(previous)
	if input.ProxyID != nil {
		validatedProxyID, proxyErr := a.validProxyID(r.Context(), *input.ProxyID)
		if proxyErr != nil {
			writeError(w, http.StatusBadRequest, "proxy_not_found", proxyErr.Error())
			return
		}
		proxyID = validatedProxyID
	}
	row, err := a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{
		ID: id, Name: name, Provider: session.Provider, Enabled: enabled, Models: models,
		Document: stripCredentialProxyFields(document), Source: "oauth", ProxyID: proxyID, ExpiresAt: expiresAt,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_save_failed", "保存 OAuth 账户失败")
		return
	}
	row, _, err = a.activateNativeCredential(r.Context(), row)
	if err != nil {
		if previous == nil {
			_ = a.store.DeleteUpstreamCredential(r.Context(), id)
		} else {
			_, _ = a.store.UpsertUpstreamCredential(r.Context(), store.UpstreamCredentialInput{
				ID: previous.ID, Name: previous.Name, Provider: previous.Provider,
				Enabled: previous.Enabled, Models: previous.Models, Document: previous.Document,
				Source: previous.Source, ProxyID: previous.ProxyID, ExpiresAt: previous.ExpiresAt,
			})
		}
		_ = a.reloadNativeCredentials(r.Context())
		writeError(w, http.StatusBadRequest, "credential_invalid", err.Error())
		return
	}
	if _, err = a.syncNativeParentSubscriptionRows(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "subscription_sync_failed", "OAuth 账户已保存，但父订阅同步失败")
		return
	}
	a.providerOAuth.remove(state)
	status := http.StatusCreated
	if previous != nil {
		status = http.StatusOK
	}
	writeJSON(w, status, nativeProviderAccount(row))
}

func mergeOAuthCredentialSettings(current, replacement json.RawMessage) (json.RawMessage, error) {
	var oldDocument, newDocument map[string]any
	if err := json.Unmarshal(current, &oldDocument); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(replacement, &newDocument); err != nil {
		return nil, err
	}
	for _, key := range []string{"prefix", "websockets", "headers"} {
		if value, ok := oldDocument[key]; ok {
			newDocument[key] = value
		}
	}
	return json.Marshal(newDocument)
}

func optionalProxyID(value *store.UpstreamCredentialSnapshot) *string {
	if value == nil {
		return nil
	}
	return value.ProxyID
}

func (a *App) adminProviderOAuthCancel(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.PathValue("state"))
	if _, ok := a.providerOAuth.snapshotByState(state); !ok {
		writeError(w, http.StatusNotFound, "oauth_session_not_found", "授权会话不存在或已过期")
		return
	}
	if a.nativeCPARuntime != nil {
		_ = a.nativeCPARuntime.CancelOAuth(r.Context(), state)
	}
	a.providerOAuth.remove(state)
	w.WriteHeader(http.StatusNoContent)
}
