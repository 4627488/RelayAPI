package relaybridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestCompatCompactionV2AndReplay(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				calls++
				if strings.Contains(string(body), "compaction_trigger") || strings.Contains(string(body), "encrypted_content") {
					t.Errorf("untranslated compaction reached %s: %s", protocol, body)
				}
				if calls == 2 && !strings.Contains(string(body), "Important retained context") {
					t.Errorf("capsule not expanded: %s", body)
				}
				w.Header().Set("Content-Type", "application/json")
				if protocol == "responses" {
					io.WriteString(w, `{"id":"resp_summary","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Important retained context"}]}],"usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60}}`)
				} else {
					io.WriteString(w, `{"id":"chat_summary","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Important retained context"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10,"total_tokens":60}}`)
				}
			}))
			defer upstream.Close()
			executor := newOpenAICompatExecutor("openai-compatibility", &sdkconfig.Config{})
			auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{"base_url": upstream.URL + "/v1", "api_key": "test", "upstream_api": protocol}}
			req := cliproxyexecutor.Request{Model: "model", Payload: []byte(`{"model":"model","input":[{"role":"user","content":"Remember the plan"},{"type":"compaction_trigger"}]}`)}
			opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}
			result, err := executor.Execute(t.Context(), auth, req, opts)
			if err != nil {
				t.Fatal(err)
			}
			item := gjson.GetBytes(result.Payload, "output.0")
			if item.Get("type").String() != "compaction" || item.Get("encrypted_content").String() == "" || gjson.GetBytes(result.Payload, "usage.total_tokens").Int() != 60 {
				t.Fatalf("invalid compaction result: %s", result.Payload)
			}
			var capsule any
			if err := json.Unmarshal([]byte(item.Raw), &capsule); err != nil {
				t.Fatal(err)
			}
			replay, _ := json.Marshal(map[string]any{"model": "model", "input": []any{capsule, map[string]string{"role": "user", "content": "Continue"}}})
			if _, err := executor.Execute(t.Context(), auth, cliproxyexecutor.Request{Model: "model", Payload: replay}, opts); err != nil {
				t.Fatal(err)
			}
			// The streaming path must emit exactly the same compaction item and a
			// terminal usage-bearing completion, suitable for both HTTP and WS.
			stream, err := executor.ExecuteStream(t.Context(), auth, req, opts)
			if err != nil {
				t.Fatal(err)
			}
			var wire strings.Builder
			for chunk := range stream.Chunks {
				if chunk.Err != nil {
					t.Fatal(chunk.Err)
				}
				wire.Write(chunk.Payload)
			}
			if !strings.Contains(wire.String(), "response.completed") || !strings.Contains(wire.String(), "encrypted_content") {
				t.Fatal(wire.String())
			}
		})
	}
}

func TestRuntimeWebSocketAdaptsChatAndCompaction(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("wrong upstream path: %s", r.URL)
		}
		if strings.Contains(string(body), "compaction_trigger") || strings.Contains(string(body), "encrypted_content") {
			t.Errorf("raw compaction reached chat: %s", body)
		}
		if gjson.GetBytes(body, "stream").Bool() {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"id\":\"chat_next\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"continued\"},\"finish_reason\":null}]}\n\n")
			io.WriteString(w, "data: {\"id\":\"chat_next\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\ndata: [DONE]\n\n")
		} else {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"id":"summary","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Remember the plan"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`)
		}
	}))
	defer upstream.Close()
	document, _ := json.Marshal(map[string]any{"type": "openai", "api_key": "test", "base_url": upstream.URL + "/v1", "upstream_api": "chat"})
	runtime, err := NewRuntime(Options{APIKey: "internal"}, []Credential{{ID: "chat-adapter", Provider: "openai", Enabled: true, Models: []string{"interop-chat-model"}, Document: document}})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	probe := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"interop-chat-model","input":[{"role":"user","content":"Remember"},{"type":"compaction_trigger"}]}`))
	request.Header.Set("Authorization", "Bearer internal")
	request.Header.Set("X-Relay-CPA-Auth-ID", "chat-adapter")
	runtime.Handler().ServeHTTP(probe, request)
	if probe.Code != http.StatusOK {
		t.Fatalf("HTTP compaction failed: %d %s", probe.Code, probe.Body.String())
	}
	server := httptest.NewServer(runtime.Handler())
	defer server.Close()
	header := http.Header{"Authorization": []string{"Bearer internal"}, "X-Relay-CPA-Auth-ID": []string{"chat-adapter"}, "X-Relay-Request-ID": []string{"compat-ws-test"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/v1/responses", header)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	input := json.RawMessage(`[{"role":"user","content":"Remember the plan"},{"type":"compaction_trigger"}]`)
	var capsule json.RawMessage
	for turn := 0; turn < 2; turn++ {
		if err := conn.WriteJSON(map[string]any{"type": "response.create", "model": "interop-chat-model", "input": input}); err != nil {
			t.Fatal(err)
		}
		completed := false
		for !completed {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			if gjson.GetBytes(payload, "type").String() == "error" {
				t.Fatalf("gateway adaptation failed: %s", payload)
			}
			if gjson.GetBytes(payload, "type").String() == "response.completed" {
				completed = true
				responseID := gjson.GetBytes(payload, "response.id").String()
				usage, complete := runtime.RequestUsage(t.Context(), "compat-ws-test", responseID)
				if !complete || !usage.Found || usage.TotalTokens != 12 {
					t.Fatalf("lost compaction/continuation usage: %+v", usage)
				}
				if turn == 0 {
					item := gjson.GetBytes(payload, "response.output.0")
					if item.Get("type").String() != "compaction" {
						t.Fatalf("not a compaction: %s", payload)
					}
					capsule = json.RawMessage(item.Raw)
				} else if !strings.Contains(string(payload), "continued") {
					t.Fatalf("continuation lost: %s", payload)
				}
			}
		}
		input, _ = json.Marshal([]any{capsule, map[string]string{"role": "user", "content": "Continue"}})
	}
}
