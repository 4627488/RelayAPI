package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginModelPreferenceAndAutoReset(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	for _, requested := range []string{"", "grok-4.6"} {
		t.Run("requested="+requested, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/rai/session" {
					http.NotFound(w, r)
					return
				}
				json.NewEncoder(w).Encode(Session{Models: []string{"gpt-5.6-sol", "grok-4.6"}, DefaultModel: "gpt-5.6-sol"})
			}))
			defer server.Close()
			app := App{Home: t.TempDir(), Stdout: &bytes.Buffer{}, Now: time.Now, Gateway: Gateway{HTTP: server.Client()}}
			if err := app.finishLogin(context.Background(), "default", server.URL, "relay_test", loginFlags{Model: requested}); err != nil {
				t.Fatal(err)
			}
			store, err := app.store()
			if err != nil {
				t.Fatal(err)
			}
			profile, err := store.ResolveProfile("default")
			if err != nil {
				t.Fatal(err)
			}
			if profile.DefaultModel != requested {
				t.Fatalf("saved model = %q", profile.DefaultModel)
			}
			if err := app.use("default", []string{"codex-code-review"}); err != nil {
				t.Fatal(err)
			}
			if err := app.use("default", []string{"--auto"}); err != nil {
				t.Fatal(err)
			}
			profile, err = store.ResolveProfile("default")
			if err != nil || profile.DefaultModel != "" {
				t.Fatalf("reset model = %q, %v", profile.DefaultModel, err)
			}
		})
	}
}
