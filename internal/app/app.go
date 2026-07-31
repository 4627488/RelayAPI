package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

type App struct {
	cfg           config.Config
	store         store.Store
	cpa           *cpa.Client
	mux           *http.ServeMux
	stop          chan struct{}
	wg            sync.WaitGroup
	bridgeReady   atomic.Bool
	bridgeVersion atomic.Value
	pricingSyncMu sync.Mutex
	oauthMu       sync.Mutex
	oauthSession  *managedOAuthSession
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
	dataStore, err := store.New(database)
	if err != nil {
		return nil, err
	}
	a := &App{cfg: cfg, store: dataStore, cpa: client, mux: http.NewServeMux(), stop: make(chan struct{})}
	a.routes()
	a.refreshBridgeStatus(ctx)
	a.wg.Add(1)
	go a.maintenance()
	return a, nil
}

func (a *App) Close() {
	if a.stop != nil {
		close(a.stop)
		a.wg.Wait()
	}
	sqlDB, err := a.store.DB.DB()
	if err == nil {
		_ = sqlDB.Close()
	}
}

func (a *App) maintenance() {
	defer a.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	quotaInterval := a.cfg.QuotaSyncInterval
	if quotaInterval < time.Minute {
		quotaInterval = 5 * time.Minute
	}
	quotaTicker := time.NewTicker(quotaInterval)
	defer quotaTicker.Stop()
	initialQuotaSync := time.NewTimer(15 * time.Second)
	defer initialQuotaSync.Stop()
	retentionTicker := time.NewTicker(time.Hour)
	defer retentionTicker.Stop()
	pricingTicker := time.NewTicker(24 * time.Hour)
	defer pricingTicker.Stop()
	initialPricingSync := time.NewTimer(2 * time.Second)
	defer initialPricingSync.Stop()
	for {
		select {
		case <-ticker.C:
			a.refreshBridgeStatus(context.Background())
			if count, err := a.store.ReclaimExpiredReservations(context.Background(), time.Now()); err != nil {
				slog.Error("reclaim expired reservations", "error", err)
			} else if count > 0 {
				slog.Info("reclaimed expired reservations", "count", count)
			}
		case <-initialQuotaSync.C:
			a.refreshParentQuotas(context.Background())
		case <-initialPricingSync.C:
			if err := a.refreshPricingCatalog(context.Background(), true); err != nil {
				slog.Warn("initial pricing catalog sync", "error", err)
			}
		case <-quotaTicker.C:
			a.refreshParentQuotas(context.Background())
		case <-pricingTicker.C:
			if err := a.refreshPricingCatalog(context.Background(), false); err != nil {
				slog.Warn("periodic pricing catalog sync", "error", err)
			}
		case <-retentionTicker.C:
			if err := a.store.PruneRequestLogs(
				context.Background(), time.Now(), a.cfg.RequestLogRetentionDays, a.cfg.RequestDetailRetentionDays,
			); err != nil {
				slog.Error("prune request logs", "error", err)
			}
		case <-a.stop:
			return
		}
	}
}

func (a *App) refreshPricingCatalog(ctx context.Context, onlyIfEmpty bool) error {
	a.pricingSyncMu.Lock()
	defer a.pricingSyncMu.Unlock()
	if onlyIfEmpty {
		items, err := a.store.ListCatalogPrices(ctx)
		if err != nil {
			return err
		}
		if len(items) > 0 {
			return nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client, err := a.cpa.OutboundHTTPClient(ctx, 30*time.Second)
	if err != nil {
		return err
	}
	result, err := pricing.FetchModelsDev(ctx, client, pricing.ModelsDevURL)
	if err != nil {
		return err
	}
	return a.store.ApplyCatalog(ctx, result)
}

func (a *App) refreshBridgeStatus(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ready, version, err := a.cpa.BridgeReady(ctx)
	if err != nil {
		slog.Warn("check CPA bridge", "error", err)
		ready = false
	}
	ready = ready && a.cfg.CPAPluginSecret != ""
	a.bridgeReady.Store(ready)
	a.bridgeVersion.Store(version)
}

func (a *App) Handler() http.Handler {
	return securityHeaders(a.recoverer(a.mux))
}

func (a *App) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("POST /internal/cpa/usage", a.cpaPluginUsage)
	a.mux.HandleFunc("POST /internal/cpa/lifecycle", a.cpaPluginLifecycle)
	a.mux.HandleFunc("GET /api/auth/status", a.authStatus)
	a.mux.HandleFunc("POST /api/auth/login", a.tenantLogin)
	a.mux.HandleFunc("POST /api/auth/register", a.register)
	a.mux.HandleFunc("POST /api/auth/logout", a.logout)
	a.mux.Handle("GET /api/me", a.withTenant(http.HandlerFunc(a.me)))
	a.mux.Handle("GET /api/dashboard", a.withTenant(http.HandlerFunc(a.dashboard)))
	a.mux.Handle("GET /api/usage", a.withTenant(http.HandlerFunc(a.usage)))
	a.mux.Handle("GET /api/subscriptions", a.withTenant(http.HandlerFunc(a.tenantSubscriptions)))
	a.mux.Handle("GET /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("POST /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("DELETE /api/keys/{id}", a.withTenant(http.HandlerFunc(a.keyDelete)))
	a.mux.Handle("GET /api/logs", a.withTenant(http.HandlerFunc(a.logs)))
	a.mux.Handle("GET /api/logs/{id}", a.withTenant(http.HandlerFunc(a.logDetail)))

	a.mux.Handle("GET /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("POST /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("PUT /api/admin/tenants/{id}", a.withAdmin(http.HandlerFunc(a.adminTenantUpdate)))
	a.mux.Handle("POST /api/admin/tenants/{id}/credit", a.withAdmin(http.HandlerFunc(a.adminCredit)))
	a.mux.Handle("POST /api/admin/tenants/{id}/password", a.withAdmin(http.HandlerFunc(a.adminPassword)))
	a.mux.Handle("GET /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("POST /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("GET /api/admin/prices", a.withAdmin(http.HandlerFunc(a.adminPrices)))
	a.mux.Handle("PUT /api/admin/prices/{model}", a.withAdmin(http.HandlerFunc(a.adminPriceUpdate)))
	a.mux.Handle("DELETE /api/admin/prices/{model}", a.withAdmin(http.HandlerFunc(a.adminPriceDelete)))
	a.mux.Handle("GET /api/admin/pricing/aliases", a.withAdmin(http.HandlerFunc(a.adminPricingAliases)))
	a.mux.Handle("PUT /api/admin/pricing/aliases", a.withAdmin(http.HandlerFunc(a.adminPricingAliases)))
	a.mux.Handle("GET /api/admin/pricing/rules", a.withAdmin(http.HandlerFunc(a.adminPricingRules)))
	a.mux.Handle("PUT /api/admin/pricing/rules", a.withAdmin(http.HandlerFunc(a.adminPricingRules)))
	a.mux.Handle("GET /api/admin/pricing/sync", a.withAdmin(http.HandlerFunc(a.adminPricingSync)))
	a.mux.Handle("POST /api/admin/pricing/sync", a.withAdmin(http.HandlerFunc(a.adminPricingSync)))
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		a.mux.Handle(method+" /api/admin/cpa/{resource...}", a.withAdmin(http.HandlerFunc(a.adminCPA)))
	}
	a.mux.Handle("GET /api/admin/providers/accounts", a.withAdmin(http.HandlerFunc(a.adminProviderAccounts)))
	a.mux.Handle("GET /api/admin/providers/accounts/{name}/models", a.withAdmin(http.HandlerFunc(a.adminProviderModels)))
	a.mux.Handle("PATCH /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountUpdate)))
	a.mux.Handle("DELETE /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountDelete)))
	a.mux.Handle("POST /api/admin/providers/codex/oauth", a.withAdmin(http.HandlerFunc(a.adminCodexOAuth)))
	a.mux.Handle("POST /api/admin/providers/{provider}/oauth", a.withAdmin(http.HandlerFunc(a.adminProviderOAuth)))
	a.mux.Handle("GET /api/admin/providers/oauth/status", a.withAdmin(http.HandlerFunc(a.adminOAuthStatus)))
	a.mux.Handle("POST /api/admin/providers/oauth/callback", a.withAdmin(http.HandlerFunc(a.adminOAuthCallback)))
	a.mux.Handle("GET /api/admin/providers/settings", a.withAdmin(http.HandlerFunc(a.adminProviderSettings)))
	a.mux.Handle("PATCH /api/admin/providers/settings", a.withAdmin(http.HandlerFunc(a.adminProviderSettings)))
	a.mux.Handle("GET /api/admin/overview", a.withAdmin(http.HandlerFunc(a.adminOverview)))
	a.mux.Handle("GET /api/admin/usage", a.withAdmin(http.HandlerFunc(a.adminUsage)))
	a.mux.Handle("GET /api/admin/logs", a.withAdmin(http.HandlerFunc(a.adminLogs)))
	a.mux.Handle("GET /api/admin/logs/{id}", a.withAdmin(http.HandlerFunc(a.adminLogDetail)))
	a.mux.Handle("GET /api/admin/invitations", a.withAdmin(http.HandlerFunc(a.adminInvitations)))
	a.mux.Handle("POST /api/admin/invitations", a.withAdmin(http.HandlerFunc(a.adminInvitations)))
	a.mux.Handle("DELETE /api/admin/invitations/{id}", a.withAdmin(http.HandlerFunc(a.adminInvitationRevoke)))
	a.mux.Handle("GET /api/admin/subscriptions/parents", a.withAdmin(http.HandlerFunc(a.adminParentSubscriptions)))
	a.mux.Handle("POST /api/admin/subscriptions/parents", a.withAdmin(http.HandlerFunc(a.adminParentSubscriptions)))
	a.mux.Handle("PATCH /api/admin/subscriptions/parents/{id}", a.withAdmin(http.HandlerFunc(a.adminParentSubscriptionUpdate)))
	a.mux.Handle("GET /api/admin/subscriptions/parents/{id}/windows", a.withAdmin(http.HandlerFunc(a.adminParentWindows)))
	a.mux.Handle("PUT /api/admin/subscriptions/parents/{id}/windows", a.withAdmin(http.HandlerFunc(a.adminParentWindows)))
	a.mux.Handle("GET /api/admin/subscriptions/parents/{id}/observations", a.withAdmin(http.HandlerFunc(a.adminParentObservations)))
	a.mux.Handle("POST /api/admin/subscriptions/parents/{id}/observations", a.withAdmin(http.HandlerFunc(a.adminParentObservations)))
	a.mux.Handle("POST /api/admin/subscriptions/sync", a.withAdmin(http.HandlerFunc(a.adminSyncParentSubscriptions)))
	a.mux.Handle("POST /api/admin/subscriptions/quota/sync", a.withAdmin(http.HandlerFunc(a.adminSyncParentQuotas)))
	a.mux.Handle("POST /api/admin/subscriptions/parents/{id}/quota/sync", a.withAdmin(http.HandlerFunc(a.adminSyncParentQuota)))
	a.mux.Handle("GET /api/admin/subscriptions/children", a.withAdmin(http.HandlerFunc(a.adminChildSubscriptions)))
	a.mux.Handle("POST /api/admin/subscriptions/children", a.withAdmin(http.HandlerFunc(a.adminChildSubscriptions)))
	a.mux.Handle("PUT /api/admin/subscriptions/children/{id}", a.withAdmin(http.HandlerFunc(a.adminChildSubscription)))
	a.mux.Handle("DELETE /api/admin/subscriptions/children/{id}", a.withAdmin(http.HandlerFunc(a.adminChildSubscription)))

	for _, pattern := range []string{"/v1/", "/backend-api/codex/", "/openai/v1/", "/v1beta/"} {
		a.mux.Handle(pattern, http.HandlerFunc(a.proxy))
	}
	a.mux.HandleFunc("/", a.frontend)
}

func (a *App) frontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	if a.cfg.WebDistDir == "" {
		a.serviceInfo(w, r)
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if clean == "." {
		clean = "index.html"
	}
	root, err := filepath.Abs(a.cfg.WebDistDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "web_root_invalid", "前端目录无效")
		return
	}
	requested := filepath.Join(root, clean)
	if rel, err := filepath.Rel(root, requested); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	if info, err := os.Stat(requested); err != nil || info.IsDir() {
		requested = filepath.Join(root, "index.html")
	}
	if filepath.Base(requested) == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, requested)
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
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	sqlDB, err := a.store.DB.DB()
	if err == nil {
		err = sqlDB.PingContext(ctx)
	}
	cpaErr := a.cpa.Ready(ctx)
	activeSubscriptions, subscriptionErr := a.store.HasActiveChildSubscriptions(ctx, time.Now())
	bridgeRequired := subscriptionErr == nil && activeSubscriptions
	bridgeOK := !bridgeRequired || a.bridgeReady.Load()
	status := http.StatusOK
	if err != nil || cpaErr != nil || subscriptionErr != nil || !bridgeOK {
		status = http.StatusServiceUnavailable
	}
	bridgeVersion, _ := a.bridgeVersion.Load().(string)
	writeJSON(w, status, map[string]any{"status": map[bool]string{true: "ok", false: "degraded"}[status == 200],
		"database": errorText(err), "cpa": errorText(cpaErr),
		"subscriptions": errorText(subscriptionErr), "bridge": map[string]any{"required": bridgeRequired, "ready": a.bridgeReady.Load(), "version": bridgeVersion}})
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
	writeJSON(w, http.StatusOK, map[string]any{"role": "tenant", "is_admin": tenant.IsAdmin, "tenant": tenant})
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
		session := currentSession(r)
		tenant, err := a.store.GetTenant(r.Context(), session.TenantID)
		if err != nil || !tenant.Enabled || !tenant.IsAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) withTenant(next http.Handler) http.Handler {
	return a.withSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if currentSession(r).TenantID == "" {
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
	tenant, err := a.store.GetTenant(r.Context(), session.TenantID)
	if err != nil || !tenant.Enabled {
		writeError(w, http.StatusUnauthorized, "unauthorized", "账户不存在或已停用")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"role": "tenant", "is_admin": tenant.IsAdmin, "tenant": tenant})
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
	if value = strings.TrimSpace(r.Header.Get("X-API-Key")); value != "" {
		return value
	}
	return strings.TrimSpace(r.Header.Get("X-Goog-API-Key"))
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
