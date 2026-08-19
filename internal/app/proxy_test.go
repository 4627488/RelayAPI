package app

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

func TestRuntimeWriterForwardsSuccessAndErrors(t *testing.T) {
	success := httptest.NewRecorder()
	out := &runtimeWriter{client: success, stream: true, capture: &rollingCapture{max: 64}}
	out.Header().Set("Content-Type", "text/event-stream")
	out.WriteHeader(http.StatusOK)
	if _, err := out.Write([]byte("data: ok\n\n")); err != nil {
		t.Fatal(err)
	}
	if success.Code != http.StatusOK || success.Body.String() != "data: ok\n\n" {
		t.Fatalf("streamed = %d %q", success.Code, success.Body.String())
	}

	errorClient := httptest.NewRecorder()
	failed := &runtimeWriter{client: errorClient, capture: &rollingCapture{max: 64}}
	failed.Header().Set("Content-Type", "application/json")
	failed.WriteHeader(http.StatusTooManyRequests)
	if _, err := failed.Write([]byte(`{"error":"busy"}`)); err != nil {
		t.Fatal(err)
	}
	if errorClient.Code != http.StatusTooManyRequests || errorClient.Body.String() != `{"error":"busy"}` {
		t.Fatalf("forwarded error = %d %q", errorClient.Code, errorClient.Body.String())
	}
	detail, _, _ := failed.capture.Info()
	if string(detail) != `{"error":"busy"}` {
		t.Fatalf("captured error = %q", detail)
	}
}

func TestRollingCaptureKeepsDetailPrefixAndBillingTail(t *testing.T) {
	capture := &rollingCapture{max: 5}
	for _, chunk := range []string{"abc", "def", "gh"} {
		if written, err := capture.Write([]byte(chunk)); err != nil || written != len(chunk) {
			t.Fatalf("write %q = %d, %v", chunk, written, err)
		}
	}
	if tail := string(capture.Bytes()); tail != "defgh" {
		t.Fatalf("billing tail = %q, want defgh", tail)
	}
	detail, truncated, total := capture.Info()
	if string(detail) != "abcdefgh" || truncated || total != 8 {
		t.Fatalf("detail = %q, truncated = %v, total = %d", detail, truncated, total)
	}
}

func BenchmarkRollingCaptureLongStream(b *testing.B) {
	chunk := bytes.Repeat([]byte("x"), 32<<10)
	b.SetBytes(int64(len(chunk) * 256))
	b.ReportAllocs()
	for range b.N {
		capture := &rollingCapture{max: 2 << 20}
		for range 256 {
			_, _ = capture.Write(chunk)
		}
		_ = capture.Bytes()
	}
}

func TestFinalizeResponseIsBoundedAndAsynchronous(t *testing.T) {
	a := &App{finalizationSlots: make(chan struct{}, 1)}
	started := make(chan struct{})
	release := make(chan struct{})
	a.finalizeResponse(func() {
		close(started)
		<-release
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("finalizer did not start")
	}

	fallbackRan := false
	a.finalizeResponse(func() { fallbackRan = true })
	if !fallbackRan {
		t.Fatal("saturated finalizer did not apply synchronous backpressure")
	}
	close(release)
	a.wg.Wait()
}

func TestRequestLogUsesResponseBoundaryInsteadOfFinalizerTime(t *testing.T) {
	started := time.Now().Add(-2 * time.Second).Truncate(time.Millisecond)
	completed := started.Add(750 * time.Millisecond)
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	input := requestLogInput(store.KeyContext{}, "request", store.Admission{}, requestMeta{}, request,
		http.StatusOK, started, nil, false, true, 0, "", requestLogContext{completedAt: completed})
	if input.LatencyMS != 750 || !input.CompletedAt.Equal(completed) {
		t.Fatalf("logged boundary = %d ms at %s, want 750 ms at %s", input.LatencyMS, input.CompletedAt, completed)
	}
}

func TestEnforceLimitsSkipsUsageQueryWhenNoDailyLimitExists(t *testing.T) {
	a := &App{}
	if err := a.enforceLimits(context.Background(), store.KeyContext{}); err != nil {
		t.Fatal(err)
	}
}

func TestRejectedRequestDetailMarksUnreadBody(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("request body"))
	request.Header.Set("X-Goog-Api-Key", "relay_gemini_secret")
	detail := rejectedRequestDetail(request, nil, "upstream_overloaded", "Upstream overloaded", time.Now())
	if detail.RequestBodyBytes != request.ContentLength || !detail.RequestBodyTruncated {
		t.Fatalf("unread body metadata = bytes %d, truncated %v", detail.RequestBodyBytes, detail.RequestBodyTruncated)
	}
	if strings.Contains(detail.RequestHeaders, "relay_gemini_secret") || detail.ErrorName != "upstream_overloaded" {
		t.Fatalf("rejected detail = %+v", detail)
	}
}

func TestSetStreamingHeadersDisablesTransformBuffering(t *testing.T) {
	header := make(http.Header)
	setStreamingHeaders(header, true)
	if header.Get("Cache-Control") != "no-cache, no-transform" || header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("streaming headers = %#v", header)
	}
}

func TestReadRequestMeta(t *testing.T) {
	tests := []struct {
		body, path, model, effort string
		stream                    bool
		imageCount                int
	}{
		{`{"model":"gpt-5.4","stream":true}`, "/v1/responses", "gpt-5.4", "", true, 0},
		{`{"model":"gpt-image","n":3,"reasoning":{"effort":"high"}}`, "/v1/responses", "gpt-image", "high", false, 3},
	}
	for _, test := range tests {
		got := readRequestMeta([]byte(test.body), test.path)
		if got.Model != test.model || got.ReasoningEffort != test.effort || got.Stream != test.stream || got.ImageCount != test.imageCount {
			t.Errorf("metadata = %+v, want model %q, effort %q, stream %t, images %d", got, test.model, test.effort, test.stream, test.imageCount)
		}
	}
}

func BenchmarkReadRequestMetaLongPrompt(b *testing.B) {
	body := []byte(`{"model":"gpt-5.6","stream":true,"reasoning":{"effort":"high"},"input":"` + strings.Repeat("x", 1<<20) + `"}`)
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for range b.N {
		_ = readRequestMeta(body, "/v1/responses")
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

func TestRequestMetadataReadsMultipartImageModel(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", "gpt-image-1"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("n", "3"); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreateFormFile("image", "input.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("not-a-real-png"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(body.Bytes()))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	meta := requestMetadata(body.Bytes(), request)
	if meta.Model != "gpt-image-1" || meta.ImageCount != 3 {
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
		body, err := rewriteRequestModel([]byte("{ \n  \"model\": \"fast\", \"large\":9007199254740993}"), request.URL, "fast", "gpt-5.6")
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "{ \n  \"model\": \"gpt-5.6\", \"large\":9007199254740993}" {
			t.Fatalf("rewrite changed unrelated JSON bytes: %s", body)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(body, &object); err != nil {
			t.Fatal(err)
		}
		if string(object["model"]) != `"gpt-5.6"` || string(object["large"]) != "9007199254740993" {
			t.Fatalf("rewritten body = %s", body)
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

func TestReadBoundedRequestBody(t *testing.T) {
	t.Run("known content length", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("payload"))
		body, err := readBoundedRequestBody(httptest.NewRecorder(), request, 16)
		if err != nil || string(body) != "payload" {
			t.Fatalf("body = %q, err = %v", body, err)
		}
	})
	t.Run("too large", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("payload"))
		body, err := readBoundedRequestBody(httptest.NewRecorder(), request, 4)
		if err == nil || len(body) > 4 {
			t.Fatalf("body bytes = %d, err = %v", len(body), err)
		}
	})
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
