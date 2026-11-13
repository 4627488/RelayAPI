package upstream

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRuntimeFlushesPassthroughStreamImmediately(t *testing.T) {
	releaseProvider := make(chan struct{})
	defer func() {
		select {
		case <-releaseProvider:
		default:
			close(releaseProvider)
		}
	}()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-releaseProvider
		_, _ = io.WriteString(w, "data: second\n\n")
	}))
	defer provider.Close()

	runtime := newTestRuntime(t, Credential{
		ID: "stream", Provider: "codex", Enabled: true, Models: []string{"gpt-stream"},
		Document: testJSON(t, map[string]any{"type": "codex", "api_key": "key", "base_url": provider.URL}),
	})
	runtimeServer := httptest.NewServer(runtime.Handler())
	defer runtimeServer.Close()
	request, err := http.NewRequest(http.MethodPost, runtimeServer.URL+"/v1/responses",
		strings.NewReader(`{"model":"gpt-stream","stream":true,"input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	responseResult := make(chan *http.Response, 1)
	errorResult := make(chan error, 1)
	go func() {
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			errorResult <- requestErr
			return
		}
		responseResult <- response
	}()

	var response *http.Response
	select {
	case response = <-responseResult:
	case requestErr := <-errorResult:
		t.Fatal(requestErr)
	case <-time.After(2 * time.Second):
		t.Fatal("stream headers were buffered until the provider completed")
	}
	reader := bufio.NewReader(response.Body)
	firstEvent := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		firstEvent <- line
	}()
	select {
	case line := <-firstEvent:
		if line != "data: first\n" {
			t.Fatalf("first event = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first SSE event was not flushed immediately")
	}
	close(releaseProvider)
	_, _ = io.Copy(io.Discard, reader)
	_ = response.Body.Close()
}

func TestResponseModelObserverHandlesSplitSSEFrames(t *testing.T) {
	observer := &responseModelObserver{stream: true}
	for _, chunk := range []string{
		"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-first\"}}\n",
		"\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"mod",
		"el\":\"gpt-final\"}}\n\n",
	} {
		_, _ = observer.Write([]byte(chunk))
	}
	if got := observer.finish(); got != "gpt-final" {
		t.Fatalf("observed model = %q", got)
	}
}

func TestRuntimeReturnsFirstProviderErrorWithoutRetry(t *testing.T) {
	var attempts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		http.Error(w, "busy", http.StatusServiceUnavailable)
	}))
	defer provider.Close()
	r, err := NewRuntime(Options{FailureThreshold: 3, FailureCooldown: time.Second}, []Credential{{ID: "openai", Provider: "codex", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "codex", "api_key": "key", "base_url": provider.URL})}})
	if err != nil {
		t.Fatal(err)
	}
	response := runtimeRequest(t, r, http.MethodPost, "/v1/responses", `{"model":"gpt","input":"hi"}`)
	if response.Code != http.StatusServiceUnavailable || attempts.Load() != 1 || !strings.Contains(response.Body.String(), "busy") {
		t.Fatalf("status = %d, attempts = %d, body = %s", response.Code, attempts.Load(), response.Body.String())
	}
}

func TestCredentialIsolationRemovesAndRestoresOnlyFailingRoute(t *testing.T) {
	runtimeValue, err := NewRuntime(Options{FailureThreshold: 2, FailureCooldown: 200 * time.Millisecond}, []Credential{
		{ID: "first", Provider: "codex", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "codex", "api_key": "one"})},
		{ID: "second", Provider: "codex", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "codex", "api_key": "two"})},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime := runtimeValue.(*nativeRuntime)
	first := runtime.credentials["first"]
	first.record(false, "temporary", true, 2, 200*time.Millisecond)
	if !first.available(time.Now()) {
		t.Fatal("credential isolated before reaching threshold")
	}
	first.record(false, "temporary", true, 2, 200*time.Millisecond)
	if first.available(time.Now()) {
		t.Fatal("credential remained routable after reaching threshold")
	}
	if err := runtime.ApplySettings(t.Context(), Settings{
		RoutingStrategy: "round-robin", ProxyURL: "direct",
		FailureThreshold: 2, FailureCooldown: 200 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}
	first = runtime.credentials["first"]
	if first.available(time.Now()) {
		t.Fatal("hot settings update discarded credential isolation state")
	}
	for range 4 {
		selected, ok := runtime.selectCredential("gpt", "", "")
		if !ok || selected.ID != "second" {
			t.Fatalf("selected credential = %#v, want healthy second route", selected)
		}
	}
	time.Sleep(205 * time.Millisecond)
	if !first.available(time.Now()) {
		t.Fatal("credential did not return after cooldown")
	}
	if first.available(time.Now()) {
		t.Fatal("credential admitted more than one half-open recovery probe")
	}
	first.record(true, "", false, 2, 200*time.Millisecond)
	if !first.available(time.Now()) {
		t.Fatal("successful recovery probe did not close credential circuit")
	}
}

func TestResponseHeaderPolicyAllowsDiagnosticsButBlocksProviderSecrets(t *testing.T) {
	source := http.Header{
		"Content-Type":        {"text/event-stream"},
		"X-Request-Id":        {"req_1"},
		"X-Ratelimit-Limit":   {"100"},
		"Retry-After":         {"2"},
		"Set-Cookie":          {"provider_session=secret"},
		"X-Provider-Internal": {"secret"},
	}
	destination := make(http.Header)
	copyResponseHeaders(destination, source)
	if destination.Get("X-Request-Id") != "req_1" || destination.Get("X-Ratelimit-Limit") != "100" || destination.Get("Retry-After") != "2" {
		t.Fatalf("diagnostic headers were removed: %#v", destination)
	}
	if destination.Get("Set-Cookie") != "" || destination.Get("X-Provider-Internal") != "" {
		t.Fatalf("unsafe provider headers escaped: %#v", destination)
	}
}

func TestProviderRequestUsesIdentityEncoding(t *testing.T) {
	source := http.Header{
		"Accept-Encoding": {"gzip"},
		"OpenAI-Beta":     {"responses=experimental"},
	}
	destination := make(http.Header)
	copyProviderHeaders(destination, source)
	if destination.Get("Accept-Encoding") != "" {
		t.Fatalf("compression negotiation escaped to provider: %#v", destination)
	}
	if destination.Get("OpenAI-Beta") != "responses=experimental" {
		t.Fatalf("safe client header was removed: %#v", destination)
	}
}

func TestCodexCatalogAdvertisesFullAgentSurfaceByDefault(t *testing.T) {
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-test"}, Document: []byte(`{"type":"codex","access_token":"token"}`)})
	response := runtimeRequest(t, runtime, http.MethodGet, "/v1/models?client_version=1", "")
	var root map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &root); err != nil {
		t.Fatal(err)
	}
	var model map[string]any
	for _, raw := range asAnySlice(root["models"]) {
		item, _ := raw.(map[string]any)
		if item["slug"] == "gpt-test" {
			model = item
			break
		}
	}
	if model == nil {
		t.Fatalf("gpt-test missing from catalog: %s", response.Body.String())
	}
	for _, key := range []string{"apply_patch_tool_type", "web_search_tool_type", "multi_agent_version", "supports_parallel_tool_calls", "supports_search_tool", "prefer_websockets"} {
		if model[key] == nil || model[key] == false {
			t.Fatalf("%s = %#v; model = %#v", key, model[key], model)
		}
	}
	if model["shell_type"] != "shell_command" || model["supported_in_api"] != true || model["default_reasoning_level"] != "medium" {
		t.Fatalf("Codex ModelInfo required fields missing: %#v", model)
	}
	if model["base_instructions"] == nil || model["base_instructions"] == "" || model["max_context_window"] == nil {
		t.Fatalf("Codex ModelInfo instructions/context missing: %#v", model)
	}
}

func TestCodexOAuthStartUsesPKCEAndStableCallback(t *testing.T) {
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt"}, Document: []byte(`{"type":"codex","access_token":"token"}`)})
	result, err := runtime.StartOAuth(t.Context(), "codex", "relay-session")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(result.URL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if result.Flow != "callback" || result.State == "" || query.Get("state") != result.State || query.Get("code_challenge_method") != "S256" || query.Get("redirect_uri") != codexRedirectURI {
		t.Fatalf("result = %#v, query = %#v", result, query)
	}
}

func TestDisabledCredentialCoolingKeepsFailedRoutesEligible(t *testing.T) {
	runtimeValue, err := NewRuntime(Options{FailureThreshold: 1, FailureCooldown: 0}, []Credential{
		{ID: "only", Provider: "codex", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "codex", "api_key": "key"})},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime := runtimeValue.(*nativeRuntime)
	credential := runtime.credentials["only"]
	credential.record(false, "temporary", true, 1, 0)
	if !credential.available(time.Now()) {
		t.Fatal("zero cooldown isolated the only credential")
	}
}

func TestRuntimeServeUsesPreparedBodyWithoutRereading(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"model":"gpt"`) {
			t.Errorf("provider body = %s", body)
		}
		_, _ = io.WriteString(w, `{"id":"resp_ok","output":[]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "openai", Provider: "codex", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "codex", "api_key": "key", "base_url": provider.URL}),
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("must-not-read"))
	request.Header.Set("X-Relay-Request-ID", "prepared-1")
	recorder := httptest.NewRecorder()
	runtime.Serve(recorder, request, []byte(`{"model":"gpt","input":"hi"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRuntimeTraceCapturesProviderAttempts(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"id":"resp_ok","output":[]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "openai", Provider: "codex", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "codex", "api_key": "key", "base_url": provider.URL}),
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	request.Header.Set("X-Relay-Request-ID", "trace-1")
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	trace, ok := runtime.TakeRequestTrace("trace-1")
	if !ok || trace.CredentialID != "openai" || len(trace.Attempts) != 1 || trace.Attempts[0].Status != "complete" {
		t.Fatalf("trace = %#v, ok = %v", trace, ok)
	}
}

func newTestRuntime(t *testing.T, credential Credential) Runtime {
	t.Helper()
	runtime, err := NewRuntime(Options{}, []Credential{credential})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })
	return runtime
}

func runtimeRequest(t *testing.T, runtime Runtime, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(response, request)
	return response
}

func testJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
