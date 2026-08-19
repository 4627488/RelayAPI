package upstream

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPrepareCodexWebsiteRequestWrapsStringInputAndDropsLimits(t *testing.T) {
	t.Parallel()
	adapted, err := prepareCodexWebsiteRequest([]byte(`{
		"model":"gpt-5.4",
		"input":"Reply with the single word pong.",
		"max_output_tokens":16,
		"max_tokens":8
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if !adapted.CollectStream {
		t.Fatal("missing stream should collect upstream SSE")
	}
	var body map[string]any
	if err := json.Unmarshal(adapted.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["store"] != false || body["stream"] != true {
		t.Fatalf("store/stream = %#v", body)
	}
	if _, ok := body["max_output_tokens"]; ok {
		t.Fatalf("max_output_tokens leaked: %#v", body)
	}
	if _, ok := body["max_tokens"]; ok {
		t.Fatalf("max_tokens leaked: %#v", body)
	}
	input := asAnySlice(body["input"])
	if len(input) != 1 {
		t.Fatalf("input = %#v", body["input"])
	}
	item, _ := input[0].(map[string]any)
	if item["role"] != "user" {
		t.Fatalf("input item = %#v", item)
	}
	content := asAnySlice(item["content"])
	part, _ := content[0].(map[string]any)
	if part["type"] != "input_text" || part["text"] != "Reply with the single word pong." {
		t.Fatalf("content = %#v", content)
	}
}

func TestPrepareCodexWebsiteRequestKeepsListInputAndClientStream(t *testing.T) {
	t.Parallel()
	adapted, err := prepareCodexWebsiteRequest([]byte(`{
		"model":"gpt-5.4",
		"store":true,
		"stream":true,
		"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if adapted.CollectStream {
		t.Fatal("client stream should pass SSE through")
	}
	var body map[string]any
	if err := json.Unmarshal(adapted.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["store"] != false {
		t.Fatalf("store = %#v", body["store"])
	}
	input := asAnySlice(body["input"])
	if len(input) != 1 {
		t.Fatalf("input rewritten: %#v", body["input"])
	}
}

func TestPrepareCodexWebsiteRequestRejectsNonJSON(t *testing.T) {
	t.Parallel()
	if _, err := prepareCodexWebsiteRequest([]byte("not-json")); err == nil {
		t.Fatal("accepted invalid JSON")
	}
}

func TestCollectResponsesSSEReadsCompletedEvent(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader(strings.Join([]string{
		"event: response.created",
		`data: {"type":"response.created","response":{"id":"resp_1","output":[]}}`,
		"",
		"event: response.completed",
		`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}}`,
		"",
	}, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response["id"] != "resp_1" || response["status"] != "completed" {
		t.Fatalf("response = %#v", response)
	}
}

func TestCollectResponsesSSEAcceptsJSONFallback(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader(`{"id":"resp_1","object":"response","output":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(payload, []byte(`"id":"resp_1"`)) {
		t.Fatalf("payload = %s", payload)
	}
}

func TestCollectResponsesSSEReportsStreamError(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader("data: {\"detail\":\"Store must be set to false\"}\n\n"))
	if err == nil {
		t.Fatal("missing error")
	}
	if !bytes.Contains(payload, []byte("Store must be set to false")) {
		t.Fatalf("payload = %s", payload)
	}
}

func TestCodexWebsiteAdaptationDoesNotTouchOtherProviders(t *testing.T) {
	observed := make(chan []byte, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		observed <- body
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chat_1", "choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}},
		})
	}))
	t.Cleanup(provider.Close)
	runtime := newTestRuntime(t, Credential{
		ID: "kimi", Provider: "kimi", Enabled: true, Models: []string{"kimi-k3"},
		Document: testJSON(t, map[string]any{"type": "kimi", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", `{"model":"kimi-k3","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	body := <-observed
	if bytes.Contains(body, []byte(`"store"`)) || !bytes.Contains(body, []byte(`"max_tokens"`)) {
		t.Fatalf("kimi body rewritten: %s", body)
	}
}

func TestCodexWebsiteCollectsNonStreamChatProbe(t *testing.T) {
	var seen map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.completed\n")
		_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}`+"\n\n")
	}))
	t.Cleanup(provider.Close)
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", `{
		"model":"gpt-5.4",
		"messages":[{"role":"user","content":"Reply with the single word pong."}],
		"max_tokens":16,
		"stream":false
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	if seen["store"] != false || seen["stream"] != true {
		t.Fatalf("upstream body = %#v", seen)
	}
	if _, ok := seen["max_output_tokens"]; ok {
		t.Fatalf("max_output_tokens forwarded: %#v", seen)
	}
	if !strings.Contains(response.Body.String(), `"object":"chat.completion"`) || !strings.Contains(response.Body.String(), `"content":"pong"`) {
		t.Fatalf("client body = %s", response.Body.String())
	}
}

func TestCodexWebsiteWrapsStringInputAndCollectsResponsesJSON(t *testing.T) {
	var seen map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"id":"resp_2","object":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}]}}`+"\n\n")
	}))
	t.Cleanup(provider.Close)
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/responses", `{"model":"gpt-5.4","input":"Reply with the single word pong.","max_output_tokens":32}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	if seen["store"] != false || seen["stream"] != true || seen["max_output_tokens"] != nil {
		t.Fatalf("upstream body = %#v", seen)
	}
	if _, ok := seen["input"].(string); ok {
		t.Fatalf("string input was not wrapped: %#v", seen["input"])
	}
	if !strings.Contains(response.Body.String(), `"status":"completed"`) || !strings.Contains(response.Body.String(), "pong") {
		t.Fatalf("client body = %s", response.Body.String())
	}
}

func TestCodexWebsitePassthroughKeepsClientStream(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["store"] != false || body["stream"] != true {
			t.Errorf("upstream body = %#v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.created\ndata: {\"type\":\"response.created\"}\n\n")
	}))
	t.Cleanup(provider.Close)
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/responses", `{
		"model":"gpt-5.4",
		"store":false,
		"stream":true,
		"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]
	}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "response.created") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
