package app

import (
	"errors"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

const raiAuthorizePath = "/rai/authorize/"

func raiAdapterNames() []string {
	return []string{"claude", "codex", "grok", "hermes", "opencode", "pi", "prime-agent"}
}

func (a *App) createRAIAuthorization(w http.ResponseWriter, r *http.Request) {
	var input struct {
		DeviceName          string `json:"device_name"`
		CodeChallenge       string `json:"code_challenge"`
		CodeChallengeMethod string `json:"code_challenge_method"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	item, interval, err := a.store.CreateRAIAuthorization(r.Context(), input.DeviceName, input.CodeChallenge, input.CodeChallengeMethod, time.Now())
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

func (a *App) raiAuthorizePage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	item, err := a.store.RAIAuthorization(r.Context(), id)
	if err != nil {
		writeRAIAuthorizeHTML(w, http.StatusNotFound, raiAuthorizeView{
			Title: "授权无效", Body: "这个 rai 授权请求不存在或已经过期。",
		})
		return
	}
	session, sessionErr := a.session(r)
	if sessionErr != nil || session.Role != "tenant" || session.Expires <= time.Now().Unix() {
		writeRAIAuthorizeHTML(w, http.StatusOK, raiAuthorizeView{
			Title: "登录以授权 rai", ID: item.ID, DeviceName: item.DeviceName,
			NeedLogin: true, Status: item.Status,
		})
		return
	}
	writeRAIAuthorizeHTML(w, http.StatusOK, a.raiAuthorizeViewFor(item, ""))
}

func (a *App) raiAuthorizeSession(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeRAIAuthorizeHTML(w, http.StatusBadRequest, raiAuthorizeView{Title: "登录失败", Body: "表单无效。"})
		return
	}
	id := r.PathValue("id")
	item, err := a.store.RAIAuthorization(r.Context(), id)
	if err != nil {
		writeRAIAuthorizeHTML(w, http.StatusNotFound, raiAuthorizeView{Title: "授权无效", Body: "这个 rai 授权请求不存在或已经过期。"})
		return
	}
	tenant, err := a.store.Login(r.Context(), r.FormValue("email"), r.FormValue("password"))
	if err != nil {
		writeRAIAuthorizeHTML(w, http.StatusUnauthorized, raiAuthorizeView{
			Title: "登录以授权 rai", ID: item.ID, DeviceName: item.DeviceName,
			NeedLogin: true, Status: item.Status, Error: "邮箱或密码错误",
		})
		return
	}
	a.setSession(w, identity.Session{Role: "tenant", TenantID: tenant.ID, PasswordVersion: tenant.PasswordVersion, Expires: time.Now().Add(12 * time.Hour).Unix()})
	http.Redirect(w, r, raiAuthorizePath+item.ID, http.StatusSeeOther)
}

func (a *App) raiAuthorizeApprove(w http.ResponseWriter, r *http.Request) {
	a.completeRAIAuthorize(w, r, true)
}

func (a *App) raiAuthorizeDeny(w http.ResponseWriter, r *http.Request) {
	a.completeRAIAuthorize(w, r, false)
}

func (a *App) completeRAIAuthorize(w http.ResponseWriter, r *http.Request, approve bool) {
	session, err := a.session(r)
	if err != nil || session.Role != "tenant" || session.Expires <= time.Now().Unix() {
		http.Redirect(w, r, raiAuthorizePath+r.PathValue("id"), http.StatusSeeOther)
		return
	}
	id := r.PathValue("id")
	if approve {
		err = a.store.ApproveRAIAuthorization(r.Context(), id, session.TenantID)
	} else {
		err = a.store.DenyRAIAuthorization(r.Context(), id, session.TenantID)
	}
	item, loadErr := a.store.RAIAuthorization(r.Context(), id)
	if loadErr != nil {
		writeRAIAuthorizeHTML(w, http.StatusNotFound, raiAuthorizeView{Title: "授权无效", Body: "这个 rai 授权请求不存在或已经过期。"})
		return
	}
	message := ""
	if err != nil {
		message = err.Error()
	}
	writeRAIAuthorizeHTML(w, http.StatusOK, a.raiAuthorizeViewFor(item, message))
}

func (a *App) raiAuthorizeViewFor(item store.RAIAuthorization, actionError string) raiAuthorizeView {
	view := raiAuthorizeView{
		Title: "授权 rai", ID: item.ID, DeviceName: item.DeviceName, Status: item.Status, Error: actionError,
	}
	switch item.Status {
	case store.RAIAuthorizationPending:
		view.Body = "批准后会创建一把专用 API Key，供这台设备上的 rai 启动 Codex、Claude Code 等客户端。"
		view.CanDecide = true
	case store.RAIAuthorizationApproved:
		view.Title = "已批准"
		view.Body = "可以关闭此页，回到终端。rai 会完成登录。"
	case store.RAIAuthorizationDenied:
		view.Title = "已拒绝"
		view.Body = "终端里的 rai login 会停止。"
	case store.RAIAuthorizationConsumed:
		view.Title = "已完成"
		view.Body = "这台设备已经取走凭据。"
	default:
		view.Title = "授权已过期"
		view.Body = "请在终端重新运行 rai login。"
	}
	return view
}

type raiAuthorizeView struct {
	Title      string
	Body       string
	ID         string
	DeviceName string
	Status     string
	NeedLogin  bool
	CanDecide  bool
	Error      string
}

func writeRAIAuthorizeHTML(w http.ResponseWriter, status int, view raiAuthorizeView) {
	setSensitiveNoStore(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	device := html.EscapeString(view.DeviceName)
	if device == "" {
		device = "rai"
	}
	errHTML := ""
	if view.Error != "" {
		errHTML = `<p class="err">` + html.EscapeString(view.Error) + `</p>`
	}
	body := html.EscapeString(view.Body)
	title := html.EscapeString(view.Title)
	id := html.EscapeString(view.ID)
	var form string
	switch {
	case view.NeedLogin:
		form = `<form method="post" action="/rai/authorize/` + id + `/session">
<label>邮箱<input type="email" name="email" autocomplete="username" required></label>
<label>密码<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">登录</button>
</form>`
	case view.CanDecide:
		form = `<form method="post" action="/rai/authorize/` + id + `/approve"><button type="submit">批准</button></form>
<form method="post" action="/rai/authorize/` + id + `/deny"><button type="submit" class="secondary">拒绝</button></form>`
	}
	_, _ = w.Write([]byte(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + title + `</title>
<style>
body{margin:0;font:16px/1.45 ui-sans-serif,system-ui,sans-serif;color:#111;background:#f4f4f1}
main{max-width:28rem;margin:12vh auto;padding:1.5rem;background:#fff;border:1px solid #d8d8d2}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1rem;color:#333}
.device{font-family:ui-monospace,monospace;font-size:.9rem}
label{display:block;margin:0 0 .75rem;font-size:.9rem}
input{display:block;width:100%;margin:.25rem 0 0;padding:.45rem .5rem;border:1px solid #bbb;box-sizing:border-box}
button{padding:.45rem .9rem;margin-right:.5rem;border:1px solid #111;background:#111;color:#fff}
button.secondary{background:#fff;color:#111}
.err{color:#8a1f11}
</style>
</head>
<body>
<main>
<h1>` + title + `</h1>
<p>设备 <span class="device">` + device + `</span></p>
<p>` + body + `</p>
` + errHTML + form + `
</main>
</body>
</html>`))
}
