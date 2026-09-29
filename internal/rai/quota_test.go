package rai

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQuotaUsesCurrentProfileKeyAndFormatsWindows(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/quota" || r.Header.Get("Authorization") != "Bearer relay_quota_test" {
			http.Error(w, "denied", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"items":[{"name":"Personal","provider":"codex","windows":[{"kind":"7d","limit_nano_usd":10000000000,"settled_nano_usd":2000000000,"reserved_nano_usd":500000000,"resets_at":"2026-10-03T12:00:00Z"}]}]}`)
	}))
	defer server.Close()
	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutCredential("work", "relay_quota_test"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "work", ServerURL: server.URL}); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	app := App{Args: []string{"--profile", "work", "quota"}, Home: home, Stdout: out, Gateway: Gateway{HTTP: server.Client()}}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Personal (codex)", "7d", "已用 $2.5000 / $10.0000", "剩余 $7.5000", "2026-10-03"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}

func TestQuotaEmptyAndUnauthorized(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
				if status == http.StatusOK {
					io.WriteString(w, `{"items":[]}`)
				}
			}))
			defer server.Close()
			items, err := (Gateway{HTTP: server.Client()}).Quota(context.Background(), server.URL, "secret")
			if status == http.StatusOK && (err != nil || len(items) != 0) {
				t.Fatalf("empty result: %v, %v", items, err)
			}
			if status != http.StatusOK && err == nil {
				t.Fatal("expected non-success response to fail")
			}
		})
	}
}
