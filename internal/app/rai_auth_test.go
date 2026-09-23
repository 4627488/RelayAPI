package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestWriteRAITokenErrorCodes(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{store.ErrAuthorizationPending, "authorization_pending"},
		{store.ErrAuthorizationDenied, "access_denied"},
		{store.ErrAuthorizationExpired, "expired_token"},
		{errors.New("other"), "invalid_grant"},
	} {
		recorder := httptest.NewRecorder()
		writeRAITokenError(recorder, test.err)
		if recorder.Header().Get("X-Relay-Error-Code") != test.code {
			t.Fatalf("%v code = %q", test.err, recorder.Header().Get("X-Relay-Error-Code"))
		}
	}
}

func TestRAIAuthorizationRoutes(t *testing.T) {
	app := &App{mux: http.NewServeMux()}
	app.cfg.WebDistDir = t.TempDir()
	const shell = "<!doctype html><html><body><div id=\"root\"></div></body></html>"
	if err := os.WriteFile(filepath.Join(app.cfg.WebDistDir, "index.html"), []byte(shell), 0600); err != nil {
		t.Fatal(err)
	}
	app.routes()
	page := httptest.NewRecorder()
	app.mux.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/rai/authorize/request", nil))
	if page.Code != http.StatusOK || page.Body.String() != shell {
		t.Fatalf("authorization page did not serve frontend: status=%d body=%q", page.Code, page.Body.String())
	}
	for _, path := range []string{"/api/rai/authorizations/id/approve", "/api/rai/authorizations/id/deny"} {
		recorder := httptest.NewRecorder()
		app.mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}")))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status=%d", path, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	app.mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/rai/authorizations/not-a-uuid", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("invalid id status=%d", recorder.Code)
	}
}
