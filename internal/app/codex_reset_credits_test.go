package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestCodexResetRefreshesOnceOnUnauthorized(t *testing.T) {
	for _, upstreamError := range []string{"HTTP 401", "HTTP 500"} {
		forced, calls := 0, 0
		app := &App{nativeRuntime: quotaRefreshRuntime{refresh: func(_ context.Context, _ string, force bool) ([]byte, bool, error) {
			if force {
				forced++
				return []byte(`{"access_token":"fresh"}`), true, nil
			}
			return []byte(`{"access_token":"current"}`), false, nil
		}}}
		err := app.withCodexResetCredential(t.Context(), store.UpstreamCredentialSnapshot{ID: "codex-1", Provider: "codex"}, "http://proxy.example", func(input gateway.QuotaProbeCredential) error {
			calls++
			if input.AuthIndex != "codex-1" || input.ProxyURL != "http://proxy.example" {
				t.Fatal("lost account or proxy")
			}
			if calls == 1 {
				return errors.New(upstreamError)
			}
			if string(input.Document) != `{"access_token":"fresh"}` {
				t.Fatal("used stale token")
			}
			return nil
		})
		if upstreamError == "HTTP 401" {
			if err != nil || calls != 2 || forced != 1 {
				t.Fatalf("calls=%d forced=%d err=%v", calls, forced, err)
			}
		} else if err == nil || calls != 1 || forced != 0 {
			t.Fatal("retried non-auth failure")
		}
	}
}

func TestCodexResetRoutesRequireAdmin(t *testing.T) {
	app := &App{mux: http.NewServeMux()}
	app.routes()
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/providers/accounts/codex-1/codex-reset-credits"},
		{http.MethodPost, "/api/admin/providers/accounts/codex-1/codex-reset-credits/consume"},
	} {
		response := httptest.NewRecorder()
		app.mux.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s status=%d", test.path, response.Code)
		}
	}
}
