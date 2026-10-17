package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func saveTestOAuth(t *testing.T, a *App, server, purpose string, expires time.Time) (Store, Profile) {
	t.Helper()
	s, err := a.store()
	if purpose == "account" {
		s, err = a.accountStore()
	}
	if err != nil {
		t.Fatal(err)
	}
	p := Profile{Name: "work", ServerURL: server}
	if purpose == "inference" {
		p.AuthMethod = "oauth"
	}
	if err := s.PutProfile(p); err != nil {
		t.Fatal(err)
	}
	name := profileCredentialName(p)
	if purpose == "account" {
		name = managementCredentialName(name)
	}
	raw, _ := json.Marshal(oauthCredential{Kind: "rai.oauth/v1", ServerURL: server, Purpose: purpose, AccessToken: "rai_at_initial", RefreshToken: "rai_rt_initial", ExpiresAt: expires})
	if _, err := s.PutCredential(name, string(raw)); err != nil {
		t.Fatal(err)
	}
	return s, p
}

func TestOAuthConcurrentHelpersRotateOnceAndPrintOnlyAccessToken(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/token" {
			t.Errorf("unexpected request: %s", r.URL)
			http.NotFound(w, r)
			return
		}
		var input map[string]string
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input["grant_type"] != "refresh_token" || input["refresh_token"] != "rai_rt_initial" {
			t.Error("wrong refresh credential")
		}
		refreshes.Add(1)
		time.Sleep(30 * time.Millisecond)
		io.WriteString(w, `{"access_token":"rai_at_renewed","refresh_token":"rai_rt_rotated","purpose":"inference","expires_in":899}`)
	}))
	defer server.Close()
	a := &App{Home: t.TempDir(), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	a.defaults()
	s, p := saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(-time.Minute))
	var group sync.WaitGroup
	for i := 0; i < 6; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			token, err := a.profileCredential(context.Background(), s, p)
			if err != nil || token != "rai_at_renewed" {
				t.Errorf("token=%q, err=%v", token, err)
			}
		}()
	}
	group.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("rotated %d times", refreshes.Load())
	}
	a.Args = []string{"--profile", p.Name, "credential", "print", "--server", server.URL}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.Stdout.(*bytes.Buffer).String() != "rai_at_renewed\n" {
		t.Fatal("credential helper exposed more than the access token")
	}
	raw, _ := s.Credential(profileCredentialName(p))
	if !strings.Contains(raw, "rai_rt_rotated") {
		t.Fatal("rotated refresh token was not saved")
	}
}

func TestOAuthManagementCommandsKeepSecretsAndKeySettings(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	const id = "11111111-1111-4111-8111-111111111111"
	var updates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rai_at_initial" {
			t.Error("wrong account token")
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/rai/manage/keys":
			io.WriteString(w, `{"item":{"id":"`+id+`","name":"Demo"},"key":"relay_created"}`)
		case r.Method == "GET" && r.URL.Path == "/api/rai/manage/keys":
			io.WriteString(w, `{"items":[{"id":"`+id+`","name":"Existing","enabled":true,"rate_limit_per_minute":7,"token_limit_daily":1234,"model_allowlist":["m"],"model_aliases":[{"alias":"fast","model":"m"}]}]}`)
		case r.Method == "PUT":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["Name"] != "Existing" || input["Enabled"] != false || input["RateLimitPerMinute"] != float64(7) || input["TokenLimitDaily"] != float64(1234) || len(input["ModelAliases"].([]any)) != 1 || len(input["ModelAllowlist"].([]any)) != 1 {
				t.Errorf("Key update discarded saved settings: %#v", input)
			}
			updates.Add(1)
			io.WriteString(w, `{"item":{"id":"`+id+`"}}`)
		case r.URL.Path == "/api/rai/manage/account":
			io.WriteString(w, `{"balance_nano_usd":9007199254740993}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := &App{Home: t.TempDir(), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	a.defaults()
	_, p := saveTestOAuth(t, a, server.URL, "account", time.Now().Add(time.Hour))
	for _, show := range []bool{false, true} {
		a.Stdout.(*bytes.Buffer).Reset()
		a.Args = []string{"--profile", p.Name, "keys", "create", "--name", "Demo"}
		if show {
			a.Args = append(a.Args, "--show-secret")
		}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		out := a.Stdout.(*bytes.Buffer).String()
		if strings.Contains(out, "relay_created") != show || strings.Contains(out, "rai_at_") || strings.Contains(out, "rai_rt_") {
			t.Fatal("unexpected secret in command output")
		}
	}
	a.Args = []string{"--profile", p.Name, "keys", "update", id, "--enabled=false"}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if updates.Load() != 1 {
		t.Fatal("update did not run")
	}
	a.Stdout.(*bytes.Buffer).Reset()
	a.Args = []string{"--profile", p.Name, "account", "status"}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(a.Stdout.(*bytes.Buffer).String(), "9007199254740993") {
		t.Fatal("integer precision was lost")
	}
	// Account login must not be readable by the inference credential helper.
	a.Args = []string{"--profile", p.Name, "credential", "print"}
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("account token was exposed as an inference credential")
	}
}

func TestOAuthRevocationOnLogoutRetainsCredentialOnFailure(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/revoke" || r.Method != "POST" {
			t.Error("logout did not use revocation endpoint")
		}
		var input map[string]string
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input["token"] != "rai_rt_initial" {
			t.Error("logout did not revoke refresh token")
		}
		if fail.Load() {
			w.WriteHeader(503)
		} else {
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	a := &App{Home: t.TempDir(), Args: []string{"--profile", "work", "logout"}, Stdout: io.Discard, Stderr: io.Discard}
	a.defaults()
	s, p := saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(-time.Hour))
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("expected revocation failure")
	}
	if _, err := s.Credential(profileCredentialName(p)); err != nil {
		t.Fatal("credential discarded before revocation succeeded")
	}
	fail.Store(false)
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Credential(profileCredentialName(p)); err == nil {
		t.Fatal("credential remained after logout")
	}
}

func TestOAuthTransportRejectsRedirectAndUnboundServer(t *testing.T) {
	var followed atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/rai/manage/keys" {
			http.Redirect(w, r, "/sink", 302)
			return
		}
		followed.Add(1)
	}))
	defer server.Close()
	g := NewGateway()
	if err := g.managementRequest(context.Background(), server.URL, "rai_at_private", "GET", "keys", nil, nil); err == nil {
		t.Fatal("accepted redirect")
	}
	if followed.Load() != 0 {
		t.Fatal("followed redirect with account credentials")
	}
	for _, raw := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com?query=1", "https://example.com/#frag", "https://[broken"} {
		if _, err := managementServer(raw); err == nil {
			t.Errorf("accepted unsafe OAuth server %q", raw)
		}
	}
	if err := validateManagementID("../api/admin/tenants"); err == nil {
		t.Fatal("accepted path injection")
	}
	for _, secret := range []string{"rai_at_private", "rai_rt_private", "rai_mgmt_private", "relay_private"} {
		if strings.Contains(redact("failure: "+secret), "private") {
			t.Errorf("redaction missed %s", secret)
		}
	}
}

func TestOAuthProxyRefreshesWithoutGivingRefreshTokenToClient(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/rai/token" {
			io.WriteString(w, `{"access_token":"rai_at_renewed","refresh_token":"rai_rt_rotated","purpose":"inference","expires_in":899}`)
			return
		}
		if r.URL.Path != "/v1/responses" {
			t.Errorf("wrong proxy path %s", r.URL)
		}
		seen = append(seen, r.Header.Get("Authorization"))
		if strings.Contains(fmt.Sprint(r.Header), "rai_rt_") || strings.Contains(fmt.Sprint(r.Header), "rai_local_") {
			t.Error("proxy leaked local or refresh credential upstream")
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	a := &App{Home: t.TempDir()}
	a.defaults()
	s, p := saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(time.Hour))
	base, local, closeProxy, err := a.startOAuthProxy(context.Background(), s, p)
	if err != nil {
		t.Fatal(err)
	}
	defer closeProxy()
	call := func(path, token string, want int) {
		t.Helper()
		req, _ := http.NewRequest("POST", base+path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != want {
			t.Fatalf("proxy status %d, wanted %d", resp.StatusCode, want)
		}
	}
	call("/v1/responses", "", 401)
	call("/api/rai/manage/keys", local, 404)
	call("/v1/responses", local, 200)
	saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(-time.Minute))
	call("/v1/responses", local, 200)
	if strings.Join(seen, ",") != "Bearer rai_at_initial,Bearer rai_at_renewed" {
		t.Fatalf("forwarded %v", seen)
	}
}

func TestConfigureCodexBootstrapsOAuthWithoutStaticKey(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	mux := http.NewServeMux()
	var serverURL string
	mux.HandleFunc("POST /api/rai/authorizations", func(w http.ResponseWriter, r *http.Request) {
		var input map[string]string
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input["code_challenge"] == "" || input["code_challenge_method"] != "S256" {
			t.Error("missing PKCE")
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{"authorization_id": "configure", "verification_uri": serverURL + "/rai/authorize/configure", "expires_in": 600, "interval": 1})
	})
	mux.HandleFunc("POST /api/rai/token", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"access_token":"rai_at_configure","refresh_token":"rai_rt_configure","purpose":"inference","expires_in":899}`)
	})
	mux.HandleFunc("GET /api/rai/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rai_at_configure" {
			t.Error("configure did not use OAuth access token")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"models": []string{"model"}, "api_base": serverURL})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	serverURL = server.URL
	codexHome := t.TempDir()
	opened := false
	a := &App{Home: t.TempDir(), Args: []string{"configure", "codex", "--server", server.URL, "-y"}, Environ: []string{"CODEX_HOME=" + codexHome}, Stdout: io.Discard, Stderr: io.Discard,
		OpenURL: func(raw string) error { opened = raw == server.URL+"/rai/authorize/configure"; return nil }}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("first configure did not open device authorization")
	}
	config, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "rai_at_") || strings.Contains(string(config), "rai_rt_") || !strings.Contains(string(config), "credential") {
		t.Fatal("Codex configuration should contain only the credential helper")
	}
	s, _ := a.store()
	profile, err := s.ResolveProfile("default")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := s.Credential(profileCredentialName(profile))
	if err != nil {
		t.Fatal(err)
	}
	saved, oauth, err := decodeOAuthCredential(raw)
	if err != nil || !oauth || saved.Purpose != "inference" || saved.RefreshToken != "rai_rt_configure" {
		t.Fatal("configure did not save the renewable device credential")
	}
	if _, err := s.Credential(profile.Name); err == nil {
		t.Fatal("legacy credential lookup can expose the OAuth token bundle")
	}
}
