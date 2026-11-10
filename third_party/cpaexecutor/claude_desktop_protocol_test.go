package relaybridge

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeDesktopNativeMessagesPreserveCachingToolsAndUsage(t *testing.T) {
	body := `{"model":"claude-sonnet-4-6","max_tokens":64,"stream":true,"thinking":{"type":"adaptive"},"system":[{"type":"text","text":"You are a helpful assistant.","cache_control":{"type":"ephemeral","ttl":"1h"}}],"tools":[{"type":"tool_search_tool_regex_20251119","name":"tool_search_tool_regex"},{"name":"mcp__search","description":"Search documents","input_schema":{"type":"object","properties":{"query":{"type":"string"}}},"defer_loading":true}],"messages":[{"role":"user","content":[{"type":"text","text":"Find docs","cache_control":{"type":"ephemeral","ttl":"1h"}}]},{"role":"assistant","content":[{"type":"tool_use","id":"search-call-1","name":"tool_search_tool_regex","input":{"pattern":"search"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"search-call-1","content":[{"type":"tool_reference","tool_name":"mcp__search"}]}]}],"safeguards":{"example":"preserve-opaque-fields"}}`
	var expected map[string]any
	if err := json.Unmarshal([]byte(body), &expected); err != nil {
		t.Fatal(err)
	}
	usage := `{"input_tokens":12,"cache_creation_input_tokens":20,"cache_read_input_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":20},"output_tokens":2}`
	sse := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[],\"usage\":" + usage + "}}\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"original-tool-id\",\"name\":\"mcp__search\",\"input\":{}}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"safeguard_results\":{\"original-tool-id\":{\"example\":true}}},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var got map[string]any
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Error(err)
		}
		for _, field := range []string{"system", "tools", "messages", "thinking", "safeguards"} {
			if !reflect.DeepEqual(got[field], expected[field]) {
				t.Errorf("native %s changed: got %s", field, raw)
			}
		}
		for _, beta := range []string{"tool-search-tool-2025-10-19", "context-1m-2025-08-07", "dangerous-tool-use-2026-09-03"} {
			if !strings.Contains(r.Header.Get("Anthropic-Beta"), beta) {
				t.Errorf("lost beta %s", beta)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Retry-After", "2")
		w.Header().Set("Request-Id", "upstream-request-id")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()
	document, _ := json.Marshal(map[string]any{"type": "claude", "api_key": "upstream-key", "base_url": upstream.URL, "auth_kind": "api_key", "native_tool_search": true})
	runtime, err := NewRuntime(Options{APIKey: "local-key", PassthroughHeaders: true}, []Credential{{ID: "desktop-protocol", Provider: "claude", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: document}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer local-key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Anthropic-Beta", "tool-search-tool-2025-10-19,context-1m-2025-08-07,dangerous-tool-use-2026-09-03")
	req.Header.Set("X-Relay-CPA-Auth-ID", "desktop-protocol")
	w := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("native stream failed %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Retry-After") != "2" || w.Header().Get("Request-Id") != "upstream-request-id" {
		t.Fatal("provider response headers were lost")
	}
	for _, value := range []string{`"type":"ping"`, `"original-tool-id"`, `"safeguard_results"`, `"cache_read_input_tokens":40`, `"ephemeral_1h_input_tokens":20`} {
		if !strings.Contains(w.Body.String(), value) {
			t.Errorf("native stream lost %s: %s", value, w.Body.String())
		}
	}
}

func TestClaudeDesktopContextErrorsPreserveProviderBody(t *testing.T) {
	payload := `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 201000 tokens > 200000 maximum"}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Should-Retry", "false")
		w.WriteHeader(400)
		_, _ = io.WriteString(w, payload)
	}))
	defer upstream.Close()
	document, _ := json.Marshal(map[string]any{"type": "claude", "api_key": "test", "base_url": upstream.URL})
	r, err := NewRuntime(Options{APIKey: "local-key", PassthroughHeaders: true}, []Credential{{ID: "context-error", Provider: "claude", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: document}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(t.Context()) })
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer local-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, req)
	var got, expected map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	_ = json.Unmarshal([]byte(payload), &expected)
	if w.Code != 400 || !reflect.DeepEqual(got, expected) {
		t.Fatalf("compaction trigger was lost: %d %s", w.Code, w.Body.String())
	}
}
