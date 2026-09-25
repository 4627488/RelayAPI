package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/identity"
)

func githubTestApp(t *testing.T) *App {
	t.Helper()
	box, err := identity.NewSecretBox(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	return &App{cfg: config.Config{PublicURL: "https://relay.example", GitHubClientID: "client", GitHubClientSecret: "secret", SessionSecret: strings.Repeat("s", 32), SecureCookies: true}, setupBox: box}
}
func TestGitHubStartPKCEAndState(t *testing.T) {
	a := githubTestApp(t)
	request := httptest.NewRequest("POST", "https://relay.example/api/auth/github/login", strings.NewReader("{}"))
	denied := httptest.NewRecorder()
	a.githubLoginStart(denied, request)
	if denied.Code != 403 {
		t.Fatal("cross-origin initiation accepted")
	}
	request.Header.Set("Origin", a.cfg.PublicURL)
	response := httptest.NewRecorder()
	a.githubLoginStart(response, request)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var payload struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	authorization, err := url.Parse(payload.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := authorization.Query()
	if authorization.Host != "github.com" || q.Get("scope") != "" || q.Get("client_secret") != "" || q.Get("code_challenge_method") != "S256" {
		t.Fatal("unsafe authorization request")
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing flow cookie")
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != githubCallbackPath {
		t.Fatal("unsafe cookie")
	}
	callback := httptest.NewRequest("GET", a.cfg.PublicURL+githubCallbackPath+"?state="+q.Get("state"), nil)
	callback.AddCookie(cookie)
	flow, err := a.githubReadFlow(callback)
	if err != nil {
		t.Fatal(err)
	}
	if len(flow.Verifier) != 43 || githubHash(flow.Verifier) != q.Get("code_challenge") {
		t.Fatal("PKCE mismatch")
	}
	callback.URL.RawQuery = "state=wrong"
	if _, err = a.githubReadFlow(callback); err == nil {
		t.Fatal("wrong state accepted")
	}
	rejected := httptest.NewRecorder()
	a.githubCallback(rejected, callback)
	if rejected.Code != 303 || rejected.Header().Get("Location") != "/?github=invalid_state" || rejected.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("invalid callback not cleared and redirected")
	}
}
func TestGitHubBindingRequiresOriginalSessionAndUnexpiredFlow(t *testing.T) {
	a := githubTestApp(t)
	session := identity.Session{Role: "tenant", TenantID: "tenant", PasswordVersion: 3, Expires: time.Now().Add(time.Hour).Unix()}
	token, _ := identity.SignSession(a.cfg.SessionSecret, session)
	flow := githubFlow{State: "nonce", Verifier: "verifier", TenantID: session.TenantID, SessionHash: githubHash(token), PasswordVersion: 3, Expires: time.Now().Add(time.Minute).Unix()}
	requestFor := func(f githubFlow, sessionToken string) *http.Request {
		body, _ := json.Marshal(f)
		sealed, _ := a.setupBox.Seal(body, githubCookie)
		r := httptest.NewRequest("GET", a.cfg.PublicURL+githubCallbackPath+"?state=nonce", nil)
		r.AddCookie(&http.Cookie{Name: githubCookie, Value: base64.RawURLEncoding.EncodeToString(sealed)})
		if sessionToken != "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: sessionToken})
		}
		return r
	}
	if _, err := a.githubReadFlow(requestFor(flow, token)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.githubReadFlow(requestFor(flow, "")); err == nil {
		t.Fatal("logged-out binding accepted")
	}
	session.TenantID = "other"
	other, _ := identity.SignSession(a.cfg.SessionSecret, session)
	if _, err := a.githubReadFlow(requestFor(flow, other)); err == nil {
		t.Fatal("different account binding accepted")
	}
	flow.Expires = time.Now().Add(-time.Second).Unix()
	if _, err := a.githubReadFlow(requestFor(flow, token)); err == nil {
		t.Fatal("expired binding accepted")
	}
}

type githubTestTransport func(*http.Request) (*http.Response, error)

func (f githubTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestGitHubIdentityExchange(t *testing.T) {
	a := githubTestApp(t)
	calls := 0
	client := &http.Client{Transport: githubTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		body := `{"id":42,"login":"octocat"}`
		switch r.URL.String() {
		case "https://github.com/login/oauth/access_token":
			if r.Method != "POST" {
				t.Fatal("exchange method")
			}
			_ = r.ParseForm()
			if r.Form.Get("code_verifier") != "verifier" || r.Form.Get("code") != "code" || r.Form.Get("client_secret") != "secret" || r.Form.Get("redirect_uri") != a.cfg.PublicURL+githubCallbackPath {
				t.Fatal("exchange parameters")
			}
			body = `{"access_token":"temporary-token"}`
		case "https://api.github.com/user":
			if r.Header.Get("Authorization") != "Bearer temporary-token" {
				t.Fatal("missing access token")
			}
		default:
			t.Fatal("unexpected endpoint")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	id, login, err := a.githubIdentityWithClient(context.Background(), client, "code", "verifier")
	if err != nil || id != 42 || login != "octocat" || calls != 2 {
		t.Fatalf("identity = %d %s %v", id, login, err)
	}
}

func TestGitHubHTTPProxyCarriesBothOAuthRequests(t *testing.T) {
	requests := make(chan string, 2)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/login/oauth/access_token" {
			_, _ = io.WriteString(w, `{"access_token":"test-token"}`)
		} else if r.URL.Path == "/user" && r.Header.Get("Authorization") == "Bearer test-token" {
			_, _ = io.WriteString(w, `{"id":42,"login":"octocat"}`)
		} else {
			http.Error(w, "unexpected request", 400)
		}
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			http.Error(w, "CONNECT required", 400)
			return
		}
		requests <- r.Host
		server, err := net.Dial("tcp", upstream.Listener.Addr().String())
		if err != nil {
			http.Error(w, "unreachable", 502)
			return
		}
		defer server.Close()
		client, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		_, _ = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() { _, _ = io.Copy(server, client) }()
		_, _ = io.Copy(client, server)
	}))
	defer proxy.Close()
	client, err := githubHTTPClient(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	// Trust only this test fixture's TLS configuration; production uses default verification.
	client.Transport.(*http.Transport).TLSClientConfig = upstream.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	client.Transport.(*http.Transport).TLSClientConfig.ServerName = upstream.Certificate().DNSNames[0]
	a := githubTestApp(t)
	id, _, err := a.githubIdentityWithClient(context.Background(), client, "code", "verifier")
	if err != nil || id != 42 {
		t.Fatalf("proxied OAuth failed: %v", err)
	}
	for _, host := range []string{"github.com:443", "api.github.com:443"} {
		select {
		case got := <-requests:
			if got != host {
				t.Fatalf("CONNECT target=%s", got)
			}
		case <-time.After(time.Second):
			t.Fatal("request bypassed proxy")
		}
	}
}

func TestGitHubProxySelectionAndDeletionProtection(t *testing.T) {
	for _, test := range []struct{ chosen, system, want string }{{"", "proxy-a", ""}, {"system", "proxy-a", "proxy-a"}, {"system", "", ""}, {"proxy-b", "proxy-a", "proxy-b"}} {
		settings := defaultNativeRuntimeSettings()
		settings.GitHubProxyID = test.chosen
		settings.SystemProxyID = test.system
		if got := githubSelectedProxyID(settings); got != test.want {
			t.Fatalf("proxy=%q, want %q", got, test.want)
		}
	}
	a := githubTestApp(t)
	a.nativeSettings.value = defaultNativeRuntimeSettings()
	a.nativeSettings.value.GitHubProxyID = "proxy-b"
	r := httptest.NewRequest("DELETE", "/api/admin/proxies/proxy-b", nil)
	r.SetPathValue("id", "proxy-b")
	w := httptest.NewRecorder()
	a.adminProxy(w, r)
	if w.Code != 409 {
		t.Fatal("in-use GitHub proxy can be deleted")
	}
	t.Setenv("HTTPS_PROXY", "http://invalid.example:8888")
	client, err := githubHTTPClient("")
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("direct mode inherited environment proxy")
	}
}
