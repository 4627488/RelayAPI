package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/cpaimport"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

type App struct {
	cfg               config.Config
	store             store.Store
	mux               *http.ServeMux
	stop              chan struct{}
	wg                sync.WaitGroup
	pricingSyncMu     sync.Mutex
	setupBox          identity.SecretBox
	nativeCPA         *cpa.Client
	nativeCPARuntime  *relaybridge.Runtime
	nativeCPAServer   *http.Server
	nativeCPAServeErr atomic.Value
	providerOAuth     providerOAuthSessions
	nativeSettings    settingsState
	memoryReclaiming  atomic.Bool
}

type contextKey string

const sessionKey contextKey = "session"
const sessionCookie = "relay_session"

func New(ctx context.Context, cfg config.Config) (*App, error) {
	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	dataStore, err := store.New(database, cfg.APIKeyEncryptionKey)
	if err != nil {
		return nil, err
	}
	setupBox, err := identity.NewSecretBox(cfg.APIKeyEncryptionKey)
	if err != nil {
		return nil, err
	}
	importGlobalProxy := ""
	if cfg.CPAImportAuthDir != "" || cfg.CPAImportConfigPath != "" {
		report, importErr := cpaimport.Import(ctx, dataStore, cfg.CPAImportAuthDir, cfg.CPAImportConfigPath, false)
		if importErr != nil {
			return nil, fmt.Errorf("import CPA credentials: %w", importErr)
		}
		importGlobalProxy = report.GlobalProxyURL
		slog.Info("CPA credentials imported", "imported", report.Imported, "unchanged", report.Skipped)
	}
	a := &App{
		cfg: cfg, store: dataStore, mux: http.NewServeMux(), stop: make(chan struct{}), setupBox: setupBox,
		providerOAuth: newProviderOAuthSessions(),
	}
	if _, err = a.syncNativeParentSubscriptionRows(ctx); err != nil {
		return nil, fmt.Errorf("synchronize native parent subscriptions: %w", err)
	}
	if err := a.startEmbeddedCPA(ctx, importGlobalProxy); err != nil {
		return nil, err
	}
	a.routes()
	a.wg.Add(1)
	go a.maintenance()
	return a, nil
}

func (a *App) Close() {
	if a.nativeCPAServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = a.nativeCPAServer.Shutdown(ctx)
		cancel()
	}
	if a.nativeCPARuntime != nil {
		_ = a.nativeCPARuntime.Close(context.Background())
	}
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
	quotaTicker := time.NewTicker(a.cfg.QuotaSyncInterval)
	defer quotaTicker.Stop()
	initialQuotaSync := time.NewTimer(15 * time.Second)
	defer initialQuotaSync.Stop()
	retentionTicker := time.NewTicker(time.Hour)
	defer retentionTicker.Stop()
	initialRetention := time.NewTimer(30 * time.Second)
	defer initialRetention.Stop()
	for {
		select {
		case <-ticker.C:
			a.reclaimExecutorCachesUnderPressure()
			if count, err := a.store.DeleteExpiredAgentSetups(context.Background(), time.Now()); err != nil {
				slog.Error("delete expired agent setups", "error", err)
			} else if count > 0 {
				slog.Info("deleted expired agent setups", "count", count)
			}
			if count, err := a.store.ReclaimExpiredReservations(context.Background(), time.Now()); err != nil {
				slog.Error("reclaim expired reservations", "error", err)
			} else if count > 0 {
				slog.Info("reclaimed expired reservations", "count", count)
			}
		case <-initialRetention.C:
			a.runRetention(context.Background())
		case <-initialQuotaSync.C:
			a.refreshParentQuotas(context.Background())
		case <-quotaTicker.C:
			a.refreshParentQuotas(context.Background())
		case <-retentionTicker.C:
			a.runRetention(context.Background())
		case <-a.stop:
			return
		}
	}
}

const largeRequestMemoryReleaseBytes = 8 << 20

func (a *App) reclaimExecutorCachesUnderPressure() {
	if a == nil || a.cfg.ExecutorCachePressureBytes == 0 {
		return
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	if stats.HeapAlloc < a.cfg.ExecutorCachePressureBytes {
		return
	}
	a.reclaimExecutorMemory("heap_pressure", stats.HeapAlloc)
}

func (a *App) reclaimAfterLargeRequest(requestBytes int) {
	if a == nil || requestBytes < largeRequestMemoryReleaseBytes {
		return
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	a.reclaimExecutorMemory("large_request_complete", stats.HeapAlloc)
}

func (a *App) reclaimExecutorMemory(reason string, heapAlloc uint64) {
	if !a.memoryReclaiming.CompareAndSwap(false, true) {
		return
	}
	defer a.memoryReclaiming.Store(false)
	relaybridge.ClearReasoningCaches()
	debug.FreeOSMemory()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	slog.Info("released executor memory", "reason", reason,
		"heap_alloc_bytes_before", heapAlloc, "heap_alloc_bytes_after", after.HeapAlloc)
}

func (a *App) runRetention(ctx context.Context) {
	stats, err := a.store.RunRetention(ctx, time.Now(), store.RetentionPolicy{
		SummaryDays:       a.cfg.RequestLogRetentionDays,
		SuccessDetailDays: a.cfg.RequestSuccessDetailDays, ErrorDetailDays: a.cfg.RequestDetailRetentionDays,
		LifecycleSuccessHours: a.cfg.LifecycleSuccessHours, LifecycleErrorDays: a.cfg.LifecycleErrorDays,
		ReservationDays: a.cfg.ReservationRetentionDays, IncompleteReservationDays: a.cfg.IncompleteReservationDays,
		QuotaObservationDays: a.cfg.QuotaObservationDays, InvitationDays: a.cfg.InvitationRetentionDays,
		BatchSize: a.cfg.RetentionBatchSize, MaxRuntime: a.cfg.RetentionMaxRuntime,
	})
	if err != nil {
		slog.Error("run retention", "error", err)
	} else if stats.RequestLogs+stats.Details+stats.LifecycleEvents+stats.LifecyclePayloads+stats.Reservations+stats.QuotaObservations+stats.Invitations > 0 {
		slog.Info("retention completed", "request_logs", stats.RequestLogs, "details", stats.Details,
			"lifecycle_events", stats.LifecycleEvents, "lifecycle_payloads", stats.LifecyclePayloads, "reservations", stats.Reservations,
			"quota_observations", stats.QuotaObservations, "invitations", stats.Invitations, "rollups", stats.Rollups)
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
	proxyURL, err := a.systemProxyURL(ctx)
	if err != nil {
		return err
	}
	client, err := cpa.OutboundHTTPClient(proxyURL, 30*time.Second)
	if err != nil {
		return err
	}
	result, err := pricing.FetchModelsDev(ctx, client, pricing.ModelsDevURL)
	if err != nil {
		return err
	}
	return a.store.ApplyCatalog(ctx, result)
}

func (a *App) Handler() http.Handler {
	return securityHeaders(a.recoverer(a.mux))
}

func (a *App) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("GET /setup/{token}/install.sh", a.agentSetupScript)
	a.mux.HandleFunc("HEAD /setup/{token}/install.sh", a.agentSetupScript)
	a.mux.HandleFunc("GET /setup/{token}/install.ps1", a.agentSetupScript)
	a.mux.HandleFunc("HEAD /setup/{token}/install.ps1", a.agentSetupScript)
	a.mux.HandleFunc("GET /api/auth/status", a.authStatus)
	a.mux.HandleFunc("POST /api/auth/login", a.tenantLogin)
	a.mux.HandleFunc("POST /api/auth/register", a.register)
	a.mux.HandleFunc("POST /api/auth/logout", a.logout)
	a.mux.Handle("GET /api/me", a.withTenantSession(http.HandlerFunc(a.me)))
	a.mux.Handle("POST /api/auth/password", a.withTenantSession(http.HandlerFunc(a.changePassword)))
	a.mux.Handle("GET /api/dashboard", a.withTenant(http.HandlerFunc(a.dashboard)))
	a.mux.Handle("GET /api/usage", a.withTenant(http.HandlerFunc(a.usage)))
	a.mux.Handle("GET /api/subscriptions", a.withTenant(http.HandlerFunc(a.tenantSubscriptions)))
	a.mux.Handle("POST /api/agent-setup", a.withTenant(http.HandlerFunc(a.createAgentSetup)))
	a.mux.Handle("GET /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("POST /api/keys", a.withTenant(http.HandlerFunc(a.keys)))
	a.mux.Handle("GET /api/keys/{id}/secret", a.withTenant(http.HandlerFunc(a.keySecret)))
	a.mux.Handle("PUT /api/keys/{id}", a.withTenant(http.HandlerFunc(a.keyUpdate)))
	a.mux.Handle("DELETE /api/keys/{id}", a.withTenant(http.HandlerFunc(a.keyDelete)))
	a.mux.Handle("GET /api/logs", a.withTenant(http.HandlerFunc(a.logs)))
	a.mux.Handle("GET /api/logs/{id}", a.withTenant(http.HandlerFunc(a.logDetail)))

	a.mux.Handle("GET /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("POST /api/admin/tenants", a.withAdmin(http.HandlerFunc(a.adminTenants)))
	a.mux.Handle("PUT /api/admin/tenants/{id}", a.withAdmin(http.HandlerFunc(a.adminTenantUpdate)))
	a.mux.Handle("DELETE /api/admin/tenants/{id}", a.withAdmin(http.HandlerFunc(a.adminTenantDelete)))
	a.mux.Handle("POST /api/admin/tenants/{id}/credit", a.withAdmin(http.HandlerFunc(a.adminCredit)))
	a.mux.Handle("POST /api/admin/tenants/{id}/password", a.withAdmin(http.HandlerFunc(a.adminPassword)))
	a.mux.Handle("GET /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("POST /api/admin/tenants/{id}/keys", a.withAdmin(http.HandlerFunc(a.adminTenantKeys)))
	a.mux.Handle("GET /api/admin/tenants/{id}/keys/{keyID}/secret", a.withAdmin(http.HandlerFunc(a.adminTenantKeySecret)))
	a.mux.Handle("PUT /api/admin/tenants/{id}/keys/{keyID}", a.withAdmin(http.HandlerFunc(a.adminTenantKeyUpdate)))
	a.mux.Handle("GET /api/admin/prices", a.withAdmin(http.HandlerFunc(a.adminPrices)))
	a.mux.Handle("PUT /api/admin/prices/{model}", a.withAdmin(http.HandlerFunc(a.adminPriceUpdate)))
	a.mux.Handle("DELETE /api/admin/prices/{model}", a.withAdmin(http.HandlerFunc(a.adminPriceDelete)))
	a.mux.Handle("GET /api/admin/pricing/aliases", a.withAdmin(http.HandlerFunc(a.adminPricingAliases)))
	a.mux.Handle("PUT /api/admin/pricing/aliases", a.withAdmin(http.HandlerFunc(a.adminPricingAliases)))
	a.mux.Handle("GET /api/admin/pricing/rules", a.withAdmin(http.HandlerFunc(a.adminPricingRules)))
	a.mux.Handle("PUT /api/admin/pricing/rules", a.withAdmin(http.HandlerFunc(a.adminPricingRules)))
	a.mux.Handle("GET /api/admin/pricing/sync", a.withAdmin(http.HandlerFunc(a.adminPricingSync)))
	a.mux.Handle("POST /api/admin/pricing/sync", a.withAdmin(http.HandlerFunc(a.adminPricingSync)))
	a.mux.Handle("GET /api/admin/providers/accounts", a.withAdmin(http.HandlerFunc(a.adminProviderAccounts)))
	a.mux.Handle("POST /api/admin/providers/accounts", a.withAdmin(http.HandlerFunc(a.adminProviderAccounts)))
	a.mux.Handle("GET /api/admin/providers/accounts/{name}/models", a.withAdmin(http.HandlerFunc(a.adminProviderModels)))
	a.mux.Handle("PATCH /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountUpdate)))
	a.mux.Handle("DELETE /api/admin/providers/accounts/{name}", a.withAdmin(http.HandlerFunc(a.adminProviderAccountDelete)))
	a.mux.Handle("POST /api/admin/providers/oauth/sessions", a.withAdmin(http.HandlerFunc(a.adminProviderOAuthStart)))
	a.mux.Handle("GET /api/admin/providers/oauth/sessions/{state}", a.withAdmin(http.HandlerFunc(a.adminProviderOAuthStatus)))
	a.mux.Handle("POST /api/admin/providers/oauth/sessions/{state}/callback", a.withAdmin(http.HandlerFunc(a.adminProviderOAuthCallback)))
	a.mux.Handle("POST /api/admin/providers/oauth/sessions/{state}/finalize", a.withAdmin(http.HandlerFunc(a.adminProviderOAuthFinalize)))
	a.mux.Handle("DELETE /api/admin/providers/oauth/sessions/{state}", a.withAdmin(http.HandlerFunc(a.adminProviderOAuthCancel)))
	a.mux.Handle("GET /api/admin/proxies", a.withAdmin(http.HandlerFunc(a.adminProxies)))
	a.mux.Handle("POST /api/admin/proxies", a.withAdmin(http.HandlerFunc(a.adminProxies)))
	a.mux.Handle("PATCH /api/admin/proxies/{id}", a.withAdmin(http.HandlerFunc(a.adminProxy)))
	a.mux.Handle("DELETE /api/admin/proxies/{id}", a.withAdmin(http.HandlerFunc(a.adminProxy)))
	a.mux.Handle("POST /api/admin/proxies/{id}/test", a.withAdmin(http.HandlerFunc(a.adminProxyTest)))
	a.mux.Handle("GET /api/admin/runtime/settings", a.withAdmin(http.HandlerFunc(a.adminNativeSettings)))
	a.mux.Handle("PATCH /api/admin/runtime/settings", a.withAdmin(http.HandlerFunc(a.adminNativeSettings)))
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
		"description": "multi-tenant native model gateway",
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
	var cpaErr error
	activeSubscriptions, subscriptionErr := a.store.HasActiveChildSubscriptions(ctx, time.Now())
	var credentialErr error
	if a.nativeCPARuntime == nil || a.nativeCPARuntime.CredentialCount() == 0 {
		credentialErr = errors.New("no enabled upstream credentials")
	}
	if serveErr := a.nativeCPAServeErr.Load(); serveErr != nil {
		cpaErr, _ = serveErr.(error)
	}
	status := http.StatusOK
	if err != nil || cpaErr != nil || credentialErr != nil || subscriptionErr != nil {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"status": map[bool]string{true: "ok", false: "degraded"}[status == 200],
		"database": errorText(err), "data_plane": "embedded_cpa", "upstream_credentials": errorText(credentialErr), "cpa": errorText(cpaErr),
		"cpa_admission": a.inferenceCPA().AdmissionStatus(), "subscriptions": errorText(subscriptionErr), "active_subscriptions": activeSubscriptions})
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
	a.setSession(w, identity.Session{Role: "tenant", TenantID: tenant.ID, PasswordVersion: tenant.PasswordVersion, Expires: time.Now().Add(12 * time.Hour).Unix()})
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
	return a.withTenantSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := currentSession(r)
		tenant, err := a.store.GetTenant(r.Context(), session.TenantID)
		if err != nil || !tenant.Enabled || !tenant.IsAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要管理员权限")
			return
		}
		if tenant.MustChangePassword {
			writeError(w, http.StatusForbidden, "password_change_required", "请先修改临时密码")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) withTenantSession(next http.Handler) http.Handler {
	return a.withSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := currentSession(r)
		if session.TenantID == "" {
			writeError(w, http.StatusForbidden, "forbidden", "需要租户权限")
			return
		}
		tenant, err := a.store.GetTenant(r.Context(), session.TenantID)
		if err != nil || !tenant.Enabled || tenant.PasswordVersion != session.PasswordVersion {
			writeError(w, http.StatusUnauthorized, "unauthorized", "登录已失效，请重新登录")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) withTenant(next http.Handler) http.Handler {
	return a.withTenantSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant, err := a.store.GetTenant(r.Context(), currentSession(r).TenantID)
		if err != nil || !tenant.Enabled {
			writeError(w, http.StatusUnauthorized, "unauthorized", "账户不存在或已停用")
			return
		}
		if tenant.MustChangePassword {
			writeError(w, http.StatusForbidden, "password_change_required", "请先修改临时密码")
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
	writeUserFacingError(w, userFacingError{
		Status: status, Code: code, Message: message,
		Retryable: defaultErrorRetryable(status, code),
	})
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
