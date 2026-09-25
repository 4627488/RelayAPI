package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

const githubCookie = "relay_github_oauth"
const githubCallbackPath = "/api/auth/github/callback"

type githubFlow struct {
	State           string `json:"state"`
	Verifier        string `json:"verifier"`
	TenantID        string `json:"tenant_id,omitempty"`
	SessionHash     string `json:"session_hash,omitempty"`
	PasswordVersion int64  `json:"password_version,omitempty"`
	Expires         int64  `json:"expires"`
}

func (a *App) githubEnabled() bool {
	return a.cfg.GitHubClientID != "" && a.cfg.GitHubClientSecret != ""
}
func githubHash(value string) string {
	h := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func githubRandom() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func (a *App) githubOrigin(w http.ResponseWriter, r *http.Request) bool {
	// JSON POST plus explicit same-origin check protects binding and login initiation.
	if r.Header.Get("Origin") != strings.TrimRight(a.cfg.PublicURL, "/") {
		writeError(w, 403, "invalid_origin", "请从本站发起操作")
		return false
	}
	return true
}
func (a *App) githubStatus(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	tenant, err := a.store.GetTenant(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, 500, "database_error", "无法读取绑定状态")
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": a.githubEnabled(), "bound": tenant.GitHubID != nil, "login": tenant.GitHubLogin})
}
func (a *App) githubPassword(w http.ResponseWriter, r *http.Request) (store.Tenant, bool) {
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return store.Tenant{}, false
	}
	tenant, err := a.store.GetTenant(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, 401, "unauthorized", "登录已失效")
		return tenant, false
	}
	checked, err := a.store.Login(r.Context(), tenant.OwnerEmail, input.Password)
	if err != nil || checked.ID != tenant.ID || checked.PasswordVersion != currentSession(r).PasswordVersion || checked.MustChangePassword {
		writeError(w, 403, "invalid_credentials", "当前密码不正确或登录已失效")
		return tenant, false
	}
	return checked, true
}
func (a *App) githubBindStart(w http.ResponseWriter, r *http.Request) {
	if !a.githubOrigin(w, r) {
		return
	}
	tenant, ok := a.githubPassword(w, r)
	if !ok {
		return
	}
	if tenant.GitHubID != nil {
		writeError(w, 409, "already_bound", "请先解绑当前 GitHub 账户")
		return
	}
	cookie, _ := r.Cookie(sessionCookie)
	a.githubStart(w, r, githubFlow{TenantID: tenant.ID, PasswordVersion: tenant.PasswordVersion, SessionHash: githubHash(cookie.Value)})
}
func (a *App) githubLoginStart(w http.ResponseWriter, r *http.Request) {
	if !a.githubOrigin(w, r) {
		return
	}
	a.githubStart(w, r, githubFlow{})
}
func (a *App) githubStart(w http.ResponseWriter, r *http.Request, flow githubFlow) {
	setSensitiveNoStore(w)
	if !a.githubEnabled() {
		writeError(w, 503, "github_disabled", "GitHub 登录尚未配置")
		return
	}
	var err error
	flow.State, err = githubRandom()
	if err != nil {
		writeError(w, 500, "oauth_error", "无法发起授权")
		return
	}
	flow.Verifier, err = githubRandom()
	if err != nil {
		writeError(w, 500, "oauth_error", "无法发起授权")
		return
	}
	flow.Expires = time.Now().Add(10 * time.Minute).Unix()
	body, _ := json.Marshal(flow)
	sealed, err := a.setupBox.Seal(body, githubCookie)
	if err != nil {
		writeError(w, 500, "oauth_error", "无法发起授权")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: githubCookie, Value: base64.RawURLEncoding.EncodeToString(sealed), Path: githubCallbackPath, MaxAge: 600, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	q := url.Values{"client_id": {a.cfg.GitHubClientID}, "redirect_uri": {a.cfg.PublicURL + githubCallbackPath}, "state": {flow.State}, "code_challenge": {githubHash(flow.Verifier)}, "code_challenge_method": {"S256"}, "prompt": {"select_account"}}
	// Public identity only: no repository, email or organization scopes.
	writeJSON(w, 200, map[string]string{"url": "https://github.com/login/oauth/authorize?" + q.Encode()})
}
func (a *App) githubReadFlow(r *http.Request) (githubFlow, error) {
	var flow githubFlow
	cookie, err := r.Cookie(githubCookie)
	if err != nil {
		return flow, err
	}
	sealed, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		return flow, err
	}
	plain, err := a.setupBox.Open(sealed, githubCookie)
	if err != nil {
		return flow, err
	}
	if err = json.Unmarshal(plain, &flow); err != nil {
		return flow, err
	}
	if flow.Expires <= time.Now().Unix() || flow.State == "" || subtle.ConstantTimeCompare([]byte(flow.State), []byte(r.URL.Query().Get("state"))) != 1 {
		return flow, errors.New("invalid state")
	}
	if flow.TenantID != "" {
		session, err := a.session(r)
		cookie, cookieErr := r.Cookie(sessionCookie)
		if err != nil || cookieErr != nil || session.TenantID != flow.TenantID || session.PasswordVersion != flow.PasswordVersion || githubHash(cookie.Value) != flow.SessionHash {
			return flow, errors.New("session changed")
		}
	}
	return flow, nil
}
func (a *App) githubCallback(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	flow, err := a.githubReadFlow(r)
	http.SetCookie(w, &http.Cookie{Name: githubCookie, Value: "", Path: githubCallbackPath, MaxAge: -1, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	target := "/"
	if flow.TenantID != "" {
		target = "/app/account"
	}
	fail := func(code string) { http.Redirect(w, r, target+"?github="+code, http.StatusSeeOther) }
	if err != nil {
		fail("invalid_state")
		return
	}
	if !a.githubEnabled() {
		fail("disabled")
		return
	}
	if r.URL.Query().Get("error") != "" {
		fail("denied")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("failed")
		return
	}
	id, login, err := a.githubIdentity(r.Context(), code, flow.Verifier)
	if err != nil {
		fail("failed")
		return
	}
	if flow.TenantID != "" {
		if err = a.store.BindGitHub(r.Context(), flow.TenantID, flow.PasswordVersion, id, login); err != nil {
			fail("conflict")
			return
		}
		http.Redirect(w, r, "/app/account?github=bound", http.StatusSeeOther)
		return
	}
	tenant, err := a.store.GitHubTenant(r.Context(), id)
	if err != nil {
		fail("unbound")
		return
	}
	a.setSession(w, identity.Session{Role: "tenant", TenantID: tenant.ID, PasswordVersion: tenant.PasswordVersion, Expires: time.Now().Add(12 * time.Hour).Unix()})
	http.Redirect(w, r, "/app", http.StatusSeeOther)
}
func (a *App) githubIdentity(ctx context.Context, code, verifier string) (int64, string, error) {
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	form := url.Values{"client_id": {a.cfg.GitHubClientID}, "client_secret": {a.cfg.GitHubClientSecret}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {a.cfg.PublicURL + githubCallbackPath}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	var token struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err = githubJSON(client, req, &token); err != nil {
		return 0, "", err
	}
	if token.Error != "" || token.AccessToken == "" {
		return 0, "", errors.New("token exchange failed")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "RelayAPI")
	var user struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err = githubJSON(client, req, &user); err != nil {
		return 0, "", err
	}
	if user.ID <= 0 || user.Login == "" {
		return 0, "", errors.New("invalid identity")
	}
	return user.ID, user.Login, nil
}
func githubJSON(client *http.Client, req *http.Request, out any) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("GitHub status " + strconv.Itoa(resp.StatusCode))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}
func (a *App) githubUnbind(w http.ResponseWriter, r *http.Request) {
	if !a.githubOrigin(w, r) {
		return
	}
	tenant, ok := a.githubPassword(w, r)
	if !ok {
		return
	}
	if err := a.store.UnbindGitHub(r.Context(), tenant.ID, tenant.PasswordVersion); err != nil {
		writeError(w, 409, "unbind_failed", "解绑失败，请刷新重试")
		return
	}
	a.setSession(w, identity.Session{Role: "tenant", TenantID: tenant.ID, PasswordVersion: tenant.PasswordVersion + 1, Expires: time.Now().Add(12 * time.Hour).Unix()})
	setSensitiveNoStore(w)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
