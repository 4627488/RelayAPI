package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/heatmap"
	"github.com/4627488/RelayAPI/internal/store"
)

func heatmapSharePath(token string) string {
	if token == "" {
		return ""
	}
	return "/share/usage/" + token + "/heatmap.svg"
}

func (a *App) usageHeatmap(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	id := currentSession(r).TenantID
	report, err := a.store.TokenHeatmap(ctx, id, time.Now())
	if err != nil {
		writeError(w, 500, "database_error", "无法读取消耗热力图")
		return
	}
	token, err := a.store.HeatmapShare(ctx, id)
	if err != nil {
		writeError(w, 500, "database_error", "无法读取分享设置")
		return
	}
	writeJSON(w, 200, struct {
		heatmap.Report
		SharePath string `json:"share_path"`
	}{report, heatmapSharePath(token)})
}

func (a *App) rotateHeatmapShare(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	if !a.heatmapShareOrigin(w, r) {
		return
	}
	token, err := a.store.RotateHeatmapShare(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, 500, "database_error", "无法生成分享链接")
		return
	}
	writeJSON(w, 200, map[string]string{"share_path": heatmapSharePath(token)})
}

func (a *App) revokeHeatmapShare(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	if !a.heatmapShareOrigin(w, r) {
		return
	}
	if err := a.store.RevokeHeatmapShare(r.Context(), currentSession(r).TenantID); err != nil {
		writeError(w, 500, "database_error", "无法关闭分享")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) heatmapShareOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" || (origin != "" && origin != strings.TrimRight(a.cfg.PublicURL, "/")) {
		writeError(w, http.StatusForbidden, "forbidden", "不允许跨站修改分享设置")
		return false
	}
	return true
}

func (a *App) sharedHeatmapSVG(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	token := r.PathValue("token")
	if !store.ValidHeatmapToken(token) {
		http.NotFound(w, r)
		return
	}
	// Use the peer address rather than a spoofable forwarding header. Shared
	// links never authorize other routes, and each request rechecks revocation.
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	if !a.allowRate("heatmap-ip:"+peer, 120) {
		w.Header().Set("Retry-After", "60")
		writeError(w, 429, "rate_limited", "请求过于频繁，请稍后重试")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	id, err := a.store.ResolveHeatmapShare(ctx, token)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		writeError(w, 503, "unavailable", "热力图暂不可用")
		return
	}
	a.writeHeatmapSVG(w, r.WithContext(ctx), id)
}

func (a *App) privateHeatmapSVG(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	a.writeHeatmapSVG(w, r.WithContext(ctx), currentSession(r).TenantID)
}

func (a *App) writeHeatmapSVG(w http.ResponseWriter, r *http.Request, tenantID string) {
	theme := r.URL.Query().Get("theme")
	if theme == "" {
		theme = "auto"
	}
	if theme != "auto" && theme != "light" && theme != "dark" {
		writeError(w, 400, "invalid_theme", "theme 必须为 auto、light 或 dark")
		return
	}
	report, err := a.store.TokenHeatmap(r.Context(), tenantID, time.Now())
	if err != nil {
		writeError(w, 503, "unavailable", "热力图暂不可用")
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Content-Disposition", `inline; filename="token-heatmap.svg"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(heatmap.SVG(report, theme))
}
