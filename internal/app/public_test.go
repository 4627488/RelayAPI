package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestRoutesRegisterWithFrontendCatchAll(t *testing.T) {
	a := &App{mux: http.NewServeMux()}
	a.routes()
}

func TestRoutesCoverSupportedClientProtocols(t *testing.T) {
	a := &App{mux: http.NewServeMux()}
	a.routes()
	for _, test := range []struct {
		name, method, path string
	}{
		{name: "Codex Responses", method: http.MethodPost, path: "/v1/responses"},
		{name: "Codex direct", method: http.MethodPost, path: "/backend-api/codex/responses"},
		{name: "OpenAI namespace", method: http.MethodPost, path: "/openai/v1/responses"},
		{name: "Grok OpenAI", method: http.MethodPost, path: "/v1/chat/completions"},
		{name: "Claude Code", method: http.MethodPost, path: "/v1/messages"},
		{name: "OpenCode", method: http.MethodPost, path: "/v1/chat/completions"},
		{name: "Gemini native", method: http.MethodPost, path: "/v1beta/models/gemini:generateContent"},
		{name: "Codex WebSocket", method: http.MethodGet, path: "/v1/responses/ws"},
		{name: "rai discovery", method: http.MethodGet, path: "/.well-known/rai.json"},
		{name: "rai session", method: http.MethodGet, path: "/api/rai/session"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			_, pattern := a.mux.Handler(request)
			if pattern == "" || pattern == "/" {
				t.Fatalf("path %q matched %q instead of the public handler", test.path, pattern)
			}
		})
	}
}

func TestAllowedSupportsGlob(t *testing.T) {
	if !allowed("claude-sonnet-4-6", []string{"claude-*"}) {
		t.Fatal("glob should match")
	}
	if allowed("gpt-5.4", []string{"claude-*"}) {
		t.Fatal("unexpected match")
	}
	if !allowed("anything", nil) {
		t.Fatal("empty allowlist should allow all")
	}
}

func TestAdmissionAuthIndexPrefersCredentialID(t *testing.T) {
	if got := admissionAuthIndex(store.Admission{UpstreamCredentialID: "cred", UpstreamAuthIndex: "legacy"}); got != "cred" {
		t.Fatalf("got %q", got)
	}
	if got := admissionAuthIndex(store.Admission{UpstreamAuthIndex: "legacy"}); got != "legacy" {
		t.Fatalf("legacy fallback = %q", got)
	}
}

func TestBearerSupportsCompatibleClientHeaders(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		header http.Header
		want   string
	}{
		{name: "bearer", header: http.Header{"Authorization": {"Bearer relay_auth"}}, want: "relay_auth"},
		{name: "anthropic", header: http.Header{"X-Api-Key": {"relay_anthropic"}}, want: "relay_anthropic"},
		{name: "gemini", header: http.Header{"X-Goog-Api-Key": {"relay_gemini"}}, want: "relay_gemini"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := &http.Request{Header: test.header}
			if got := bearer(request); got != test.want {
				t.Fatalf("bearer() = %q, want %q", got, test.want)
			}
		})
	}
}
