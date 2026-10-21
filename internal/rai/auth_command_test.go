package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAuthHelpDoesNotRequireCredentials(t *testing.T) {
	for _, args := range [][]string{{"auth"}, {"auth", "login", "--help"}, {"help", "auth", "status"}, {"model", "--help"}, {"key", "--help"}, {"device", "--help"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			out := &bytes.Buffer{}
			a := App{Args: args, Home: t.TempDir(), Stdout: out, Stderr: io.Discard}
			if err := a.Execute(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "USAGE") {
				t.Fatal(out.String())
			}
		})
	}
}

func TestAuthRejectsUnsupportedPermissionsAndFlags(t *testing.T) {
	for _, args := range [][]string{
		{"login", "--scope", "admin"}, {"login", "--scope", "inference,account"},
		{"login", "--scope", "account", "--with-token"}, {"token", "--scope", "account"},
		{"logout", "--server", "https://other.example"}, {"refresh", "--with-token"},
		{"switch"}, {"status", "extra"}, {"unknown"},
	} {
		a := App{Args: append([]string{"auth"}, args...), Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard}
		if err := a.Execute(context.Background()); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestAuthStatusSwitchAndTokenKeepScopesSeparate(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rai_at_initial" {
			t.Error("unexpected credential")
		}
		switch r.URL.Path {
		case "/api/rai/session":
			io.WriteString(w, `{"models":["test-model"]}`)
		case "/api/rai/manage/session":
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	out := &bytes.Buffer{}
	a := App{Home: t.TempDir(), Stdout: out, Stderr: io.Discard}
	a.defaults()
	inference, _ := saveTestOAuth(t, &a, server.URL, "inference", time.Now().Add(time.Hour))
	account, _ := saveTestOAuth(t, &a, server.URL, "account", time.Now().Add(time.Hour))
	for _, s := range []Store{inference, account} {
		if err := s.PutProfile(Profile{Name: "other", ServerURL: server.URL}); err != nil {
			t.Fatal(err)
		}
		if err := s.SetActive("other"); err != nil {
			t.Fatal(err)
		}
	}
	a.Args = []string{"auth", "switch", "--profile", "work", "--scope", "account"}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	ic, _ := inference.Load()
	ac, _ := account.Load()
	if ic.ActiveProfile != "other" || ac.ActiveProfile != "work" {
		t.Fatal("switch crossed scopes")
	}
	for _, scope := range []string{"inference", "account"} {
		out.Reset()
		a.Args = []string{"auth", "status", "--scope", scope, "--profile", "work", "--json"}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		var entries []authStatusEntry
		if err := json.Unmarshal(out.Bytes(), &entries); err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Scope != scope || !entries[0].Valid {
			t.Fatal(out.String())
		}
		if strings.Contains(out.String(), "rai_at_") || strings.Contains(out.String(), "rai_rt_") {
			t.Fatal("status leaked a token")
		}
	}
	out.Reset()
	a.Args = []string{"auth", "token", "--profile", "work"}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if out.String() != "rai_at_initial\n" {
		t.Fatal("helper output contains more than the access token")
	}
	// An invalid target must not change the active inference profile.
	if err := inference.SetActive("work"); err != nil {
		t.Fatal(err)
	}
	a.Args = []string{"auth", "switch", "--profile", "other"}
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("switched to missing credential")
	}
	ic, _ = inference.Load()
	if ic.ActiveProfile != "work" {
		t.Fatal("failed switch changed the active profile")
	}
}

func TestAuthStatusFailureReturnsErrorAndRedactsRemoteBody(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rai_at_secret rai_rt_secret\x1b[2J", http.StatusUnauthorized)
	}))
	defer server.Close()
	out := &bytes.Buffer{}
	a := App{Home: t.TempDir(), Stdout: out, Stderr: io.Discard, Args: []string{"auth", "status", "--json"}}
	a.defaults()
	saveTestOAuth(t, &a, server.URL, "inference", time.Now().Add(time.Hour))
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("status succeeded for revoked authorization")
	}
	if strings.Contains(out.String(), "rai_at_") || strings.Contains(out.String(), "rai_rt_") || !strings.Contains(out.String(), `"valid": false`) {
		t.Fatal(out.String())
	}
}

func TestAuthLoginWithTokenAndModelAliases(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/rai.json":
			io.WriteString(w, `{"name":"test"}`)
		case "/api/rai/session":
			if r.Header.Get("Authorization") != "Bearer relay_manual" {
				t.Error("wrong API Key")
			}
			io.WriteString(w, `{"models":["model-a"],"default_model":"model-a"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := App{Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard, Stdin: strings.NewReader("relay_manual\n"), Args: []string{"auth", "login", "--server", server.URL, "--with-token", "--profile", "work"}}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"model", "list"}, {"model", "set", "model-a"}} {
		a.Args = args
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	s, _ := a.store()
	p, err := s.ResolveProfile("work")
	if err != nil || p.DefaultModel != "model-a" || p.AuthMethod != "api_key" {
		t.Fatalf("profile=%+v err=%v", p, err)
	}
	a.Args = []string{"auth", "refresh"}
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("refreshed a static API Key")
	}
}

func TestAuthAccountRefreshDeniedPreservesAuthorization(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	var revoked bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/rai/authorizations":
			if revoked {
				t.Error("old authorization revoked before approval")
			}
			io.WriteString(w, `{"authorization_id":"test","verification_uri":"http://`+r.Host+`/rai/authorize/test","expires_in":60}`)
		case "/api/rai/token":
			http.Error(w, `{"error":{"code":"access_denied"}}`, http.StatusForbidden)
		case "/api/rai/revoke":
			revoked = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := App{Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard, Args: []string{"auth", "refresh", "--scope", "account", "--no-browser"}}
	a.defaults()
	s, p := saveTestOAuth(t, &a, server.URL, "account", time.Now().Add(time.Hour))
	before, _ := s.Credential(managementCredentialName(p.Name))
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("denied refresh succeeded")
	}
	after, _ := s.Credential(managementCredentialName(p.Name))
	if revoked || before != after {
		t.Fatal("denied reauthorization destroyed existing login")
	}
}

func TestAuthAccountBrowserLoginAndResourceAliases(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/rai/authorizations":
			var input map[string]any
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input["purpose"] != "account" || input["code_challenge_method"] != "S256" {
				t.Errorf("invalid permission request: %v", input)
			}
			io.WriteString(w, `{"authorization_id":"test","verification_uri":"http://`+r.Host+`/rai/authorize/test","expires_in":60}`)
		case "/api/rai/token":
			io.WriteString(w, `{"access_token":"rai_at_account","refresh_token":"rai_rt_account","purpose":"account","expires_in":900}`)
		case "/api/rai/manage/session":
			io.WriteString(w, `{}`)
		case "/api/rai/manage/keys", "/api/rai/manage/devices":
			if r.Header.Get("Authorization") != "Bearer rai_at_account" {
				t.Error("wrong resource token")
			}
			io.WriteString(w, `{"items":[]}`)
		default:
			t.Errorf("unexpected request %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := App{Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard, Args: []string{"auth", "login", "--scope", "account", "--server", server.URL, "--no-browser"}}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	s, _ := a.store()
	cfg, _ := s.Load()
	if len(cfg.Profiles) != 0 {
		t.Fatal("account login created inference authorization")
	}
	for _, resource := range []string{"key", "device", "keys", "devices"} {
		a.Args = []string{resource, "list"}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatalf("%s: %v", resource, err)
		}
	}
	a.Args = []string{"auth", "token"}
	if err := a.Execute(context.Background()); err == nil {
		t.Fatal("inference helper read account login")
	}
}

func TestAuthLogoutRetainsCredentialWhenRevocationFails(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/revoke" {
			t.Errorf("unexpected request %s", r.URL)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	for _, scope := range []string{"inference", "account"} {
		a := App{Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard, Args: []string{"auth", "logout", "--scope", scope}}
		a.defaults()
		s, p := saveTestOAuth(t, &a, server.URL, scope, time.Now().Add(time.Hour))
		if err := a.Execute(context.Background()); err == nil {
			t.Fatal("logout succeeded after failed revocation")
		}
		if _, err := s.ResolveProfile(p.Name); err != nil {
			t.Fatal("failed revocation removed profile")
		}
		credential := profileCredentialName(p)
		if scope == "account" {
			credential = managementCredentialName(p.Name)
		}
		if _, err := s.Credential(credential); err != nil {
			t.Fatal("failed revocation removed credential")
		}
	}
}
