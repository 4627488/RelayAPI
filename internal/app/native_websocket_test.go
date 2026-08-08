package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/dataplane"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

func TestNativeResponsesWebSocketEndToEnd(t *testing.T) {
	t.Parallel()
	type observed struct {
		Authorization string
		Beta          string
		Body          map[string]any
	}
	observedCh := make(chan observed, 1)
	accountingCh := make(chan billing.Result, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var body map[string]any
		_ = json.Unmarshal(payload, &body)
		observedCh <- observed{Authorization: r.Header.Get("Authorization"), Beta: r.Header.Get("OpenAI-Beta"), Body: body}
		_ = conn.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{
			"id": "resp_test", "usage": map[string]any{"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
		}})
		_, _, _ = conn.ReadMessage()
	}))
	defer upstream.Close()

	endpoint, err := url.Parse(upstream.URL + "/responses")
	if err != nil {
		t.Fatal(err)
	}
	catalog := dataplane.NewCredentialCatalog()
	if err := catalog.Replace([]dataplane.Credential{{
		ID: "codex", Provider: "codex", Endpoint: endpoint, ProxyURL: "direct", AccessToken: "upstream-token",
		Models: []dataplane.ModelRoute{{Public: "gpt-test", Upstream: "gpt-upstream"}},
	}}); err != nil {
		t.Fatal(err)
	}
	translator := dataplane.NewTranslator()
	app := &App{
		cfg: config.Config{CPAMaxRequestBytes: 1 << 20}, credentials: catalog,
		translator: translator, transports: dataplane.NewTransportPool(4, time.Minute),
	}
	app.engine = dataplane.NewEngine(translator, app.transports)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "request-test", nil, accounting)
		accountingCh <- accounting.result
	}))
	defer downstream.Close()

	wsURL := "ws" + downstream.URL[len("http"):] + "/v1/responses"
	headers := http.Header{"X-OpenAI-Internal-Codex-Responses-Lite": []string{"true"}}
	client, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.WriteJSON(map[string]any{
		"type": "response.create", "model": "gpt-test", "input": []any{}, "parallel_tool_calls": true,
	}); err != nil {
		t.Fatal(err)
	}
	_, response, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(response, &event); err != nil || event["type"] != "response.completed" {
		t.Fatalf("downstream event = %s, error = %v", response, err)
	}
	_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))

	select {
	case got := <-observedCh:
		if got.Authorization != "Bearer upstream-token" {
			t.Fatalf("authorization = %q", got.Authorization)
		}
		if got.Beta != responsesWebSocketBeta {
			t.Fatalf("OpenAI-Beta = %q", got.Beta)
		}
		if got.Body["type"] != "response.create" || got.Body["model"] != "gpt-upstream" || got.Body["parallel_tool_calls"] != false {
			t.Fatalf("upstream body = %#v", got.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upstream websocket request")
	}
	select {
	case got := <-accountingCh:
		if !got.Found || got.RequestID != "resp_test" || got.Usage.Prompt != 11 || got.Usage.Completion != 7 || got.Usage.Total != 18 {
			t.Fatalf("accounting result = %#v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for websocket accounting")
	}
}

func TestNativeResponsesWebSocketReusesCPAExecutorSession(t *testing.T) {
	var connections atomic.Int32
	requests := make(chan map[string]any, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connections.Add(1)
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for i := 1; i <= 2; i++ {
			_, payload, readErr := conn.ReadMessage()
			if readErr != nil {
				return
			}
			var body map[string]any
			_ = json.Unmarshal(payload, &body)
			requests <- body
			_ = conn.WriteJSON(map[string]any{
				"type":     "response.completed",
				"response": map[string]any{"id": "resp_" + string(rune('0'+i)), "status": "completed", "output": []any{}},
			})
		}
	}))
	defer upstream.Close()

	endpoint, _ := url.Parse(upstream.URL + "/responses")
	catalog := dataplane.NewCredentialCatalog()
	if err := catalog.Replace([]dataplane.Credential{{
		ID: "codex", Provider: "codex", Endpoint: endpoint, ProxyURL: "direct", AccessToken: "token",
		Models: []dataplane.ModelRoute{{Public: "gpt-test", Upstream: "gpt-upstream"}},
	}}); err != nil {
		t.Fatal(err)
	}
	translator := dataplane.NewTranslator()
	app := &App{cfg: config.Config{CPAMaxRequestBytes: 1 << 20}, credentials: catalog,
		translator: translator, transports: dataplane.NewTransportPool(4, time.Minute)}
	app.engine = dataplane.NewEngine(translator, app.transports)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "session-test", nil, accounting)
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-test", "input": []any{}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	if err := client.WriteJSON(map[string]any{
		"type": "response.append", "previous_response_id": "resp_1", "input": []any{},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))

	first, second := <-requests, <-requests
	if got := first["type"]; got != "response.create" {
		t.Fatalf("first type = %#v", got)
	}
	if got := second["type"]; got != "response.create" {
		t.Fatalf("second type = %#v, want response.create", got)
	}
	if got := second["previous_response_id"]; got != "resp_1" {
		t.Fatalf("second previous_response_id = %#v", got)
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("upstream websocket connections = %d, want 1", got)
	}
}

func TestMergeNativeWebSocketResultSumsTurns(t *testing.T) {
	var result billing.Result
	mergeNativeWebSocketResult(&result, billing.Result{RequestID: "resp_1", Found: true,
		Usage: store.Usage{Prompt: 10, Completion: 4, Total: 14}})
	mergeNativeWebSocketResult(&result, billing.Result{RequestID: "resp_2", ResponseServiceTier: "priority", Found: true,
		Usage: store.Usage{Prompt: 6, Completion: 3, Cached: 2, Reasoning: 1, Total: 9}})

	if result.RequestID != "resp_2" || result.ResponseServiceTier != "priority" ||
		result.Usage.Prompt != 16 || result.Usage.Completion != 7 || result.Usage.Cached != 2 ||
		result.Usage.Reasoning != 1 || result.Usage.Total != 23 {
		t.Fatalf("merged result = %#v", result)
	}
}
