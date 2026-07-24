package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

type App struct {
	cfg   config.Config
	store store.Store
	cpa   *cpa.Client
	mux   *http.ServeMux
}

type contextKey string

const sessionKey contextKey = "session"
const sessionCookie = "relay_session"

func New(ctx context.Context, cfg config.Config) (*App, error) {
	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	client, err := cpa.New(cfg.CPAURL, cfg.CPAAPIKey, cfg.CPAManagementKey, cfg.RequestTimeout)
	if err != nil {
		return nil, err
	}
	a := &App{cfg: cfg, store: store.Store{DB: database}, cpa: client, mux: http.NewServeMux()}
	a.routes()
	return a, nil
}

func (a *App) Close() {
	sqlDB, err := a.store.DB.DB()
	if err == nil {
		_ = sqlDB.Close()
	}
}

func (a *App) Handler() http.Handler {
	return securityHeaders(a.recoverer(a.mux))
}

func (a *App) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("POST /internal/cpa/usage", a.cpaPluginUsage)
	a.mux.HandleFunc("POST /api/auth/admin", a.adminLogin)
	a.mux.HandleFunc("POST /api/auth/login", a.tenantLogin)
	a.mux.HandleFunc("POST /api/auth/register", a.register)
	a.mux.HandleFunc("POST /api/auth/logout", a.logout)
	a.mux.Handle("GET /api/me", a.withSession(http.HandlerFunc(a.me)))
	a.mux.Handle("GET /api/dashboard", a.withTenant(http.HandlerFunc(a.dashboard)))
	a.mux.Handle("GET /api/usage", a.withTenant(http.HandlerFunc(a.usage)))
	a.mux.Handle("GET /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("POST /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("DELETE /api/keys/{id}", a.withTenant(http.HandlerFunc(a.keyDelete)))
	a.mux.Handle("GET /api/logs", a.withSession(http.HandlerFunc(a.logs)))

	a.mux.Handle("GET /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("POST /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("PUT /api/admin/tenants/{id}", a.withAdmin(http.HandlerFunc(a.adminTenantUpdate)))
	a.mux.Handle("POST /api/admin/tenants/{id}/credit", a.withAdmin(http.HandlerFunc(a.adminCredit)))
	a.mux.Handle("POST /api/admin/tenants/{id}/password", a.withAdmin(http.HandlerFunc(a.adminPassword)))
	a.mux.Handle("GET /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("POST /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("GET /api/admin/prices", a.withAdmin(http.HandlerFunc(a.adminPrices)))
	a.mux.Handle("PUT /api/admin/prices/{model}", a.withAdmin(http.HandlerFunc(a.adminPriceUpdate)))
	a.mux.Handle("GET /api/admin/cpa/{resource}", a.withAdmin(http.HandlerFunc(a.adminCPA)))
	a.mux.Handle("GET /api/admin/providers/accounts", a.withAdmin(http.HandlerFunc(a.adminProviderAccounts)))
	a.mux.Handle("GET /api/admin/providers/accounts/{name}/models", a.withAdmin(http.HandlerFunc(a.adminProviderModels)))
	a.mux.Handle("PATCH /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountUpdate)))
	a.mux.Handle("DELETE /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountDelete)))
	a.mux.Handle("POST /api/admin/providers/codex/oauth", a.withAdmin(http.HandlerFunc(a.adminCodexOAuth)))
	a.mux.Handle("GET /api/admin/providers/oauth/status", a.withAdmin(http.HandlerFunc(a.adminOAuthStatus)))
	a.mux.Handle("POST /api/admin/providers/oauth/callback", a.withAdmin(http.HandlerFunc(a.adminOAuthCallback)))
	a.mux.Handle("GET /api/admin/providers/settings", a.withAdmin(http.HandlerFunc(a.adminProviderSettings)))
	a.mux.Handle("PATCH /api/admin/providers/settings", a.withAdmin(http.HandlerFunc(a.adminProviderSettings)))
	a.mux.Handle("GET /api/admin/overview", a.withAdmin(http.HandlerFunc(a.adminOverview)))
	a.mux.Handle("GET /api/admin/usage", a.withAdmin(http.HandlerFunc(a.adminUsage)))
	a.mux.Handle("GET /api/admin/invitations", a.withAdmin(http.HandlerFunc(a.adminInvitations)))
	a.mux.Handle("POST /api/admin/invitations", a.withAdmin(http.HandlerFunc(a.adminInvitations)))
	a.mux.Handle("DELETE /api/admin/invitations/{id}", a.withAdmin(http.HandlerFunc(a.adminInvitationRevoke)))

	for _, pattern := range []string{"/v1/", "/backend-api/codex/", "/openai/v1/", "/v1beta/"} {
		a.mux.Handle(pattern, http.HandlerFunc(a.proxy))
	}
	a.mux.HandleFunc("GET /", a.serviceInfo)
}

func (a *App) serviceInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        "RelayAPI",
		"description": "multi-tenant gateway for CLIProxyAPI",
		"health":      "/healthz",
		"models":      "/v1/models",
	})
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	sqlDB, err := a.store.DB.DB()
	if err == nil {
		err = sqlDB.PingContext(r.Context())
	}
	cpaErr := a.cpa.Ready(r.Context())
	status := http.StatusOK
	if err != nil || cpaErr != nil {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"status": map[bool]string{true: "ok", false: "degraded"}[status == 200],
		"database": errorText(err), "cpa": errorText(cpaErr)})
}

func (a *App) adminLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Key string `json:"key"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(input.Key), []byte(a.cfg.AdminAccessKey)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "访问密钥错误")
		return
	}
	a.setSession(w, identity.Session{Role: "admin", Expires: time.Now().Add(12 * time.Hour).Unix()})
	writeJSON(w, http.StatusOK, map[string]string{"role": "admin"})
}

func (a *App) tenantLogin(w http.ResponseWriter, r *http.Request) {
	var input struct{ Email, Password string }
	if !decodeJSON(w, r, &input) {
		return
	}
	tenant, err := a.store.Login(r.Context(), input.Email, input.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码错误")
		return
	}
	a.setSession(w, identity.Session{Role: "tenant", TenantID: tenant.ID, Expires: time.Now().Add(12 * time.Hour).Unix()})
	writeJSON(w, http.StatusOK, map[string]any{"role": "tenant", "tenant": tenant})
}

func (a *App) logout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: a.cfg.SecureCookies})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) setSession(w http.ResponseWriter, session identity.Session) {
	token, _ := identity.SignSession(a.cfg.SessionSecret, session)
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", Expires: time.Unix(session.Expires, 0),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: a.cfg.SecureCookies})
}

func (a *App) session(r *http.Request) (identity.Session, error) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return identity.Session{}, err
	}
	return identity.VerifySession(a.cfg.SessionSecret, cookie.Value)
}

func (a *App) withSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := a.session(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey, session)))
	})
}

func (a *App) withAdmin(next http.Handler) http.Handler {
	return a.withSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if currentSession(r).Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "需要管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) withTenant(next http.Handler) http.Handler {
	return a.withSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if currentSession(r).Role != "tenant" {
			writeError(w, http.StatusForbidden, "forbidden", "需要租户权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func currentSession(r *http.Request) identity.Session {
	value, _ := r.Context().Value(sessionKey).(identity.Session)
	return value
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	session := currentSession(r)
	result := map[string]any{"role": session.Role}
	if session.TenantID != "" {
		if tenant, err := a.store.GetTenant(r.Context(), session.TenantID); err == nil {
			result["tenant"] = tenant
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求 JSON 无效")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func errorText(err error) any {
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func (a *App) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				slog.Error("panic", "value", value, "path", r.URL.Path)
				writeError(w, http.StatusInternalServerError, "internal_error", "服务内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(value) > 7 && strings.EqualFold(value[:7], "Bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return strings.TrimSpace(r.Header.Get("X-API-Key"))
}

func allowed(model string, lists ...[]string) bool {
	for _, list := range lists {
		if len(list) == 0 {
			continue
		}
		found := false
		for _, item := range list {
			matched, _ := path.Match(strings.ToLower(item), strings.ToLower(model))
			if item == "*" || strings.EqualFold(item, model) || matched {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

var _ = errors.Is
