package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

var errStreamTest = errors.New("stream test failure")

type failingStreamReader struct{}

func (failingStreamReader) Read([]byte) (int, error) { return 0, errStreamTest }

type failingResponseWriter struct{ header http.Header }

func (w *failingResponseWriter) Header() http.Header     { return w.header }
func (*failingResponseWriter) Write([]byte) (int, error) { return 0, errStreamTest }
func (*failingResponseWriter) WriteHeader(int)           {}

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
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			_, pattern := a.mux.Handler(request)
			if pattern == "" || pattern == "/" {
				t.Fatalf("path %q matched %q instead of the inference proxy", test.path, pattern)
			}
		})
	}
}

func TestCopyStreamingClassifiesOnlyUpstreamReadFailures(t *testing.T) {
	if err := copyStreaming(httptest.NewRecorder(), failingStreamReader{}, nil); !isUpstreamStreamError(err) {
		t.Fatalf("upstream read error was not classified: %v", err)
	}
	writer := &failingResponseWriter{header: make(http.Header)}
	if err := copyStreaming(writer, strings.NewReader("payload"), nil); err == nil || isUpstreamStreamError(err) {
		t.Fatalf("downstream write error misclassified: %v", err)
	}
}

func TestReadRequestMeta(t *testing.T) {
	tests := []struct{ body, path, model string }{
		{`{"model":"gpt-5.4","stream":true}`, "/v1/responses", "gpt-5.4"},
		{`{"contents":[]}`, "/v1beta/models/gemini-3.5-pro:generateContent", "gemini-3.5-pro"},
		{`{"contents":[]}`, "/v1beta/models/prefix%2Fmodel:streamGenerateContent", "prefix/model"},
	}
	for _, test := range tests {
		got := readRequestMeta([]byte(test.body), test.path)
		if got.Model != test.model {
			t.Errorf("model = %q, want %q", got.Model, test.model)
		}
	}
}

func TestRequestMetadataReadsWebSocketQueryModel(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "http://relay.test/v1/realtime?model=gpt-realtime", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	meta := requestMetadata(nil, request)
	if meta.Model != "gpt-realtime" || !meta.Stream {
		t.Fatalf("metadata = %+v", meta)
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

func TestResolveAPIKeyModelIsCaseInsensitive(t *testing.T) {
	meta := resolveAPIKeyModel("FAST", []store.APIKeyModelAlias{{Alias: "fast", Model: "gemini-2.5-flash"}})
	if meta.RequestedModel != "FAST" || meta.Model != "gemini-2.5-flash" || meta.ModelAlias != "FAST" {
		t.Fatalf("resolved model = %+v", meta)
	}
	passthrough := resolveAPIKeyModel("gpt-5.6", nil)
	if passthrough.Model != "gpt-5.6" || passthrough.RequestedModel != "gpt-5.6" || passthrough.ModelAlias != "" {
		t.Fatalf("passthrough model = %+v", passthrough)
	}
}

func TestRewriteRequestModelCoversBodyPathAndQuery(t *testing.T) {
	t.Run("json body preserves other raw values", func(t *testing.T) {
		request, _ := http.NewRequest(http.MethodPost, "http://relay.test/v1/responses", nil)
		body, err := rewriteRequestModel([]byte(`{"model":"fast","large":9007199254740993}`), request.URL, "fast", "gpt-5.6")
		if err != nil {
			t.Fatal(err)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(body, &object); err != nil {
			t.Fatal(err)
		}
		if string(object["model"]) != `"gpt-5.6"` || string(object["large"]) != "9007199254740993" {
			t.Fatalf("rewritten body = %s", body)
		}
	})
	t.Run("gemini path", func(t *testing.T) {
		request, _ := http.NewRequest(http.MethodPost, "http://relay.test/v1beta/models/fast:generateContent", nil)
		if _, err := rewriteRequestModel(nil, request.URL, "fast", "gemini-2.5-flash"); err != nil {
			t.Fatal(err)
		}
		if request.URL.Path != "/v1beta/models/gemini-2.5-flash:generateContent" {
			t.Fatalf("rewritten path = %q", request.URL.Path)
		}
	})
	t.Run("query", func(t *testing.T) {
		request, _ := http.NewRequest(http.MethodGet, "http://relay.test/v1/realtime?model=fast&voice=alloy", nil)
		if _, err := rewriteRequestModel(nil, request.URL, "fast", "gpt-realtime"); err != nil {
			t.Fatal(err)
		}
		if request.URL.Query().Get("model") != "gpt-realtime" || request.URL.Query().Get("voice") != "alloy" {
			t.Fatalf("rewritten query = %q", request.URL.RawQuery)
		}
	})
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

func TestCopyHeadersDropsInternalRelayHeaders(t *testing.T) {
	source := http.Header{
		"Content-Type":             {"application/json"},
		"X-Relay-Cpa-Auth-Id":      {"attacker-selected-auth"},
		"X-Relay-Plugin-Secret":    {"attacker-secret"},
		"X-Relay-Arbitrary-Future": {"must-not-pass"},
	}
	destination := make(http.Header)
	copyHeaders(destination, source)
	if got := destination.Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	for name := range source {
		if name != "Content-Type" && destination.Get(name) != "" {
			t.Fatalf("internal header %s was forwarded", name)
		}
	}
}

func TestStripRelayHeaders(t *testing.T) {
	header := http.Header{
		"X-Relay-Cpa-Auth-Id":   {"attacker-selected-auth"},
		"X-Relay-Plugin-Secret": {"attacker-secret"},
		"X-Api-Key":             {"public-key"},
	}
	stripRelayHeaders(header)
	if header.Get("X-Relay-Cpa-Auth-Id") != "" || header.Get("X-Relay-Plugin-Secret") != "" {
		t.Fatal("internal Relay headers were not stripped")
	}
	if header.Get("X-Api-Key") != "public-key" {
		t.Fatal("non-Relay headers must be preserved")
	}
}

func TestSetRoutingSignature(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	header := make(http.Header)
	setRoutingSignature(header, "request-1", "auth-2", "shared-secret", now)
	mac := hmac.New(sha256.New, []byte("shared-secret"))
	_, _ = mac.Write([]byte("request-1\nauth-2\n1800000000"))
	if got := header.Get("X-Relay-Plugin-Signature"); got != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatalf("signature = %q", got)
	}
}

func TestExtractModelsFromCPAResponse(t *testing.T) {
	models := extractModels(map[string]any{"models": []any{
		map[string]any{"id": "gpt-5.4"},
		map[string]any{"name": "claude-sonnet-4-6"},
	}})
	if len(models) != 2 || models[0] != "gpt-5.4" || models[1] != "claude-sonnet-4-6" {
		t.Fatalf("models = %#v", models)
	}
}
