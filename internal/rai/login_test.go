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

func TestLoginBrowserPollsUntilApproved(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	pending := 2
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"name":"RelayAPI","kind":"rai.dev/v1","authorization":"/api/rai/authorizations","token":"/api/rai/token"}`)
	})
	mux.HandleFunc("POST /api/rai/authorizations", func(w http.ResponseWriter, r *http.Request) {
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if input["code_challenge_method"] != "S256" || input["code_challenge"] == "" {
			http.Error(w, "bad challenge", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"authorization_id":"auth-1","verification_uri":"http://relay.example/rai/authorize/auth-1","expires_in":600,"interval":1}`)
	})
	mux.HandleFunc("POST /api/rai/token", func(w http.ResponseWriter, _ *http.Request) {
		if pending > 0 {
			pending--
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"code":"authorization_pending","message":"wait"}}`)
			return
		}
		io.WriteString(w, `{"api_key":"relay_browser","name":"RelayAPI"}`)
	})
	mux.HandleFunc("GET /api/rai/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer relay_browser" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"name":"RelayAPI","models":["gpt-test"],"default_model":"gpt-test"}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var opened string
	stdout := &bytes.Buffer{}
	app := App{
		Args:    []string{"login", "--server", server.URL, "--profile", "work", "--no-browser"},
		Home:    t.TempDir(),
		Stdout:  stdout,
		Stderr:  &bytes.Buffer{},
		Gateway: Gateway{HTTP: server.Client()},
		Now:     func() time.Time { return time.Date(2026, 8, 26, 3, 0, 0, 0, time.UTC) },
		OpenURL: func(rawURL string) error { opened = rawURL; return nil },
		Sleep:   func(context.Context, time.Duration) error { return nil },
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "Signed in") {
		t.Fatalf("stdout = %s", stdout.String())
	}
	if opened != "" {
		t.Fatalf("opened browser despite --no-browser: %s", opened)
	}
	if pending != 0 {
		t.Fatalf("pending polls left = %d", pending)
	}
}

func TestLoginOpensBrowserByDefault(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"name":"RelayAPI","kind":"rai.dev/v1"}`)
	})
	mux.HandleFunc("POST /api/rai/authorizations", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"authorization_id":"auth-2","verification_uri":"http://relay.example/rai/authorize/auth-2","expires_in":60,"interval":1}`)
	})
	mux.HandleFunc("POST /api/rai/token", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"api_key":"relay_opened"}`)
	})
	mux.HandleFunc("GET /api/rai/session", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"models":["m"],"default_model":"m"}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	var opened string
	app := App{
		Args:    []string{"login", "--server", server.URL},
		Home:    t.TempDir(),
		Stdout:  &bytes.Buffer{},
		Stderr:  &bytes.Buffer{},
		Gateway: Gateway{HTTP: server.Client()},
		Now:     time.Now,
		OpenURL: func(rawURL string) error { opened = rawURL; return nil },
		Sleep:   func(context.Context, time.Duration) error { return nil },
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(opened, "/rai/authorize/auth-2") {
		t.Fatalf("opened = %q", opened)
	}
}

func TestSelectReleaseAsset(t *testing.T) {
	asset, ok := selectReleaseAsset([]ReleaseAsset{
		{Name: "relayapi-linux-amd64", URL: "no"},
		{Name: "rai-linux-amd64", URL: "yes"},
	}, "linux", "amd64")
	if !ok || asset.URL != "yes" {
		t.Fatalf("asset = %#v ok=%v", asset, ok)
	}
}

func TestClaudeToolSearch(t *testing.T) {
	if !claudeToolSearch("anthropic/claude-sonnet-4.6") || !claudeToolSearch("claude-opus-4") {
		t.Fatal("expected anthropic models to enable tool search")
	}
	if claudeToolSearch("openrouter/auto") || claudeToolSearch("gpt-5.2") {
		t.Fatal("expected open models to disable tool search")
	}
}
