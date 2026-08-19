package upstream

import (
	"bufio"
	"bytes"
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
		ID: "stream", Provider: "openai", Enabled: true, Models: []string{"gpt-stream"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
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

func TestKimiResponsesTranslationPreservesToolsAndUsage(t *testing.T) {
	observed := make(chan map[string]any, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer kimi-token" {
			t.Errorf("request = %s, auth = %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		observed <- body
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chat_1", "model": "kimi-upstream", "created": 42,
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "done"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
		})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "kimi", Provider: "kimi", Enabled: true, Models: []string{"kimi-code"}, Document: testJSON(t, map[string]any{"type": "kimi", "access_token": "kimi-token", "base_url": provider.URL})})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/responses", `{"model":"kimi-code","instructions":"be exact","input":"hello","tools":[{"type":"custom","name":"apply_patch"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	request := <-observed
	messages := asAnySlice(request["messages"])
	if len(messages) != 2 || messages[0].(map[string]any)["role"] != "system" || messages[1].(map[string]any)["role"] != "user" {
		t.Fatalf("messages = %#v", messages)
	}
	tools := asAnySlice(request["tools"])
	function := tools[0].(map[string]any)["function"].(map[string]any)
	if function["name"] != "apply_patch" {
		t.Fatalf("tools = %#v", tools)
	}
	var output map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if output["object"] != "response" || output["status"] != "completed" {
		t.Fatalf("response = %#v", output)
	}
	usage := output["usage"].(map[string]any)
	if usage["input_tokens"] != float64(7) || usage["output_tokens"] != float64(3) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestCodexChatTranslationPreservesBetaAndModelRoute(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" || r.Header.Get("OpenAI-Beta") != "client-beta" || r.Header.Get("ChatGPT-Account-ID") != "account-1" {
			t.Errorf("path/headers = %s %#v", r.URL.Path, r.Header)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "gpt-upstream" || len(asAnySlice(body["input"])) != 1 {
			t.Errorf("body = %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "resp_1", "model": "gpt-upstream", "created_at": 42, "status": "completed", "output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "ok"}}}}, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-public"}, Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "account_id": "account-1", "base_url": provider.URL, "model_routes": []any{map[string]any{"public": "gpt-public", "upstream": "gpt-upstream"}}})})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-public","messages":[{"role":"user","content":"hi"}]}`))
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	request.Header.Set("OpenAI-Beta", "client-beta")
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"object":"chat.completion"`) || !strings.Contains(recorder.Body.String(), `"content":"ok"`) {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestXAIApplyPatchRestoredForNonStreamingResponses(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), `"type":"custom"`) || !strings.Contains(string(body), `"type":"function"`) {
			t.Errorf("tool was not lowered: %s", body)
		}
		_, _ = io.WriteString(w, `{"id":"resp_1","output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"apply_patch","arguments":"{\"input\":\"*** Begin Patch\"}"}]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "xai", Provider: "xai", Enabled: true, Models: []string{"grok"}, Document: testJSON(t, map[string]any{"type": "xai", "api_key": "key", "base_url": provider.URL})})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/responses", `{"model":"grok","tools":[{"type":"custom","name":"apply_patch"}],"input":"edit"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"type":"custom_tool_call"`) || !strings.Contains(response.Body.String(), `"input":"*** Begin Patch"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestRuntimeRetriesTransientProviderFailure(t *testing.T) {
	var attempts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"id":"resp_ok","output":[]}`)
	}))
	defer provider.Close()
	r, err := NewRuntime(Options{RequestRetry: 1, RetryMaxBackoff: time.Millisecond, FailureThreshold: 3, FailureCooldown: time.Second}, []Credential{{ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL})}})
	if err != nil {
		t.Fatal(err)
	}
	response := runtimeRequest(t, r, http.MethodPost, "/v1/responses", `{"model":"gpt","input":"hi"}`)
	if response.Code != http.StatusOK || attempts.Load() != 2 {
		t.Fatalf("status = %d, attempts = %d, body = %s", response.Code, attempts.Load(), response.Body.String())
	}
}

func TestCredentialIsolationRemovesAndRestoresOnlyFailingRoute(t *testing.T) {
	runtimeValue, err := NewRuntime(Options{FailureThreshold: 2, FailureCooldown: 200 * time.Millisecond}, []Credential{
		{ID: "first", Provider: "openai", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "openai", "api_key": "one"})},
		{ID: "second", Provider: "openai", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "openai", "api_key": "two"})},
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
		RoutingStrategy: "round-robin", RetryMaxBackoff: time.Second, ProxyURL: "direct",
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
	model := asAnySlice(root["models"])[0].(map[string]any)
	for _, key := range []string{"apply_patch_tool_type", "web_search_tool_type", "multi_agent_version", "supports_parallel_tool_calls", "supports_search_tool", "prefer_websockets"} {
		if model[key] == nil || model[key] == false {
			t.Fatalf("%s = %#v; model = %#v", key, model[key], model)
		}
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

func TestToolRestorerTracksStreamingApplyPatch(t *testing.T) {
	payload, restore := lowerCodexTools([]byte(`{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`))
	if restore == nil || !bytes.Contains(payload, []byte(`"name":"editor__apply_patch"`)) {
		t.Fatalf("lowered = %s", payload)
	}
	added := restore.restore([]byte("data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"name\":\"editor__apply_patch\",\"arguments\":\"\"}}\n\n"))
	if !bytes.Contains(added, []byte(`"type":"custom_tool_call"`)) || !bytes.Contains(added, []byte(`"namespace":"editor"`)) {
		t.Fatalf("added = %s", added)
	}
	delta := restore.restore([]byte("data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"ignored\"}\n\n"))
	if len(delta) != 0 {
		t.Fatalf("delta = %s", delta)
	}
}

func TestChatStreamTranslationEmitsCompleteResponsesLifecycle(t *testing.T) {
	source := strings.Join([]string{
		`data: {"id":"chat_1","model":"kimi","created":42,"choices":[{"delta":{"content":"hello "},"finish_reason":null}]}`,
		``,
		`data: {"id":"chat_1","model":"kimi","choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}`,
		``, `data: {"id":"chat_1","model":"kimi","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}`,
		``, `data: [DONE]`, ``,
	}, "\n")
	var output bytes.Buffer
	if err := translateStream(&output, strings.NewReader(source), "chat-to-responses", "fallback"); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, event := range []string{"response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.output_item.done", "response.completed"} {
		if !strings.Contains(text, `event: `+event) {
			t.Fatalf("missing %s in %s", event, text)
		}
	}
	if !strings.Contains(text, `"text":"hello world"`) || !strings.Contains(text, `"total_tokens":4`) {
		t.Fatalf("translated stream = %s", text)
	}
}

func TestResponsesCustomToolStreamProducesValidChatArguments(t *testing.T) {
	source := strings.Join([]string{
		`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ct_1","type":"custom_tool_call","call_id":"call_1","name":"apply_patch","input":""}}`, ``,
		`data: {"type":"response.custom_tool_call_input.delta","output_index":0,"delta":"*** Begin "}`, ``,
		`data: {"type":"response.custom_tool_call_input.delta","output_index":0,"delta":"Patch\n"}`, ``,
		`data: {"type":"response.custom_tool_call_input.done","output_index":0,"input":"*** Begin Patch\n"}`, ``,
		`data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`, ``,
	}, "\n")
	var output bytes.Buffer
	if err := translateStream(&output, strings.NewReader(source), "responses-to-chat", "gpt"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"arguments":"{\"input\":\"*** Begin Patch\\n\"}"`) {
		t.Fatalf("custom tool arguments are not valid JSON: %s", output.String())
	}
}

func TestResponsesStreamTranslationEmitsChatToolDeltas(t *testing.T) {
	source := strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt"}}`, ``,
		`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"shell","arguments":""}}`, ``,
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"cmd\":"}`, ``,
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"pwd\"}"}`, ``,
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}`, ``,
	}, "\n")
	var output bytes.Buffer
	if err := translateStream(&output, strings.NewReader(source), "responses-to-chat", "fallback"); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if !strings.Contains(text, `"name":"shell"`) || !strings.Contains(text, `"finish_reason":"tool_calls"`) || !strings.Contains(text, `"total_tokens":5`) || !strings.Contains(text, "data: [DONE]") {
		t.Fatalf("translated stream = %s", text)
	}
}

func TestBailianChatRequestsUseResponsesAndStayOnTheSameCredential(t *testing.T) {
	var keys []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("path = %s, want /responses", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["prompt_cache_key"] != "conv-1" {
			t.Errorf("prompt_cache_key = %#v", body["prompt_cache_key"])
		}
		keys = append(keys, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "resp_bailian", "object": "response", "status": "completed",
			"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "ok"}}}},
			"usage":  map[string]any{"input_tokens": 10, "output_tokens": 2, "input_tokens_details": map[string]any{"cached_tokens": 8}},
		})
	}))
	defer provider.Close()

	runtimeValue, err := NewRuntime(Options{}, []Credential{
		{ID: "bailian-a", Provider: "aliyun-bailian", Enabled: true, Models: []string{"qwen-plus"}, Document: testJSON(t, map[string]any{"type": "openai-compatibility", "api_key": "key-a", "base_url": provider.URL})},
		{ID: "bailian-b", Provider: "aliyun-bailian", Enabled: true, Models: []string{"qwen-plus"}, Document: testJSON(t, map[string]any{"type": "openai-compatibility", "api_key": "key-b", "base_url": provider.URL})},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime := runtimeValue.(*nativeRuntime)
	if compiled := runtime.credentials["bailian-a"]; compiled == nil || !compiled.SessionAffinity || compiled.Vendor != "aliyun-bailian" {
		t.Fatalf("bailian credential = %#v", compiled)
	}
	body := `{"model":"qwen-plus","prompt_cache_key":"conv-1","messages":[{"role":"user","content":"hi"}]}`
	first := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", body)
	second := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", body)
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("status = %d / %d, body = %s / %s", first.Code, second.Code, first.Body.String(), second.Body.String())
	}
	if !strings.Contains(first.Body.String(), `"object":"chat.completion"`) {
		t.Fatalf("client protocol was not restored: %s", first.Body.String())
	}
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("session affinity keys = %#v", keys)
	}
}

func TestDisabledCredentialCoolingKeepsFailedRoutesEligible(t *testing.T) {
	runtimeValue, err := NewRuntime(Options{FailureThreshold: 1, FailureCooldown: 0}, []Credential{
		{ID: "only", Provider: "openai", Enabled: true, Models: []string{"gpt"}, Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key"})},
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
		ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
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
		ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
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
