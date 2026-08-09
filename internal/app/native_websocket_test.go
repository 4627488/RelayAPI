package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

type nativeWebSocketTestResult struct {
	session nativeWebSocketSessionState
	err     error
}

func TestNativeResponsesWebSocketProbeDisconnectIsNotAnError(t *testing.T) {
	app := &App{cfg: config.Config{CPAMaxRequestBytes: 1 << 20}}
	resultCh := make(chan nativeWebSocketTestResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, _, err := app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "probe-test", nil,
			&nativeWebSocketAccounting{})
		resultCh <- nativeWebSocketTestResult{session: session, err: err}
	}))
	defer server.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+server.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = client.UnderlyingConn().Close()

	select {
	case got := <-resultCh:
		if !got.session.upgraded || got.session.established || got.err != nil {
			t.Fatalf("probe result = %#v, error = %v", got.session, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for probe disconnect")
	}
}

func TestNativeResponsesWebSocketClientDisconnectIsNotAnError(t *testing.T) {
	upstreamReady := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if _, _, err = conn.ReadMessage(); err != nil {
			return
		}
		upstreamReady <- struct{}{}
		_, _, _ = conn.ReadMessage()
	}))
	defer upstream.Close()

	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: mustJSON(t, map[string]any{
			"type": "codex", "access_token": "token", "base_url": upstream.URL, "websockets": true,
		}),
	})
	resultCh := make(chan nativeWebSocketTestResult, 1)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, _, err := app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "disconnect-test", nil,
			&nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "codex"}})
		resultCh <- nativeWebSocketTestResult{session: session, err: err}
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-test", "input": []any{}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-upstreamReady:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upstream request")
	}
	_ = client.UnderlyingConn().Close()

	select {
	case got := <-resultCh:
		if !got.session.upgraded || !got.session.established || got.err != nil {
			t.Fatalf("client disconnect result = %#v, error = %v", got.session, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for client disconnect")
	}
}

func TestNativeResponsesWebSocketUpstreamDisconnectRemainsAnError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		if _, _, err = conn.ReadMessage(); err != nil {
			_ = conn.Close()
			return
		}
		_ = conn.UnderlyingConn().Close()
	}))
	defer upstream.Close()

	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: mustJSON(t, map[string]any{
			"type": "codex", "access_token": "token", "base_url": upstream.URL, "websockets": true,
		}),
	})
	resultCh := make(chan nativeWebSocketTestResult, 1)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, _, err := app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "upstream-error-test", nil,
			&nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "codex"}})
		resultCh <- nativeWebSocketTestResult{session: session, err: err}
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-test", "input": []any{}}); err != nil {
		t.Fatal(err)
	}
	_, _, _ = client.ReadMessage()

	select {
	case got := <-resultCh:
		if !got.session.upgraded || !got.session.established || got.err == nil {
			t.Fatalf("upstream disconnect result = %#v, error = %v", got.session, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upstream disconnect")
	}
}

func TestNativeResponsesWebSocketCompletedThenUpstreamEOFClosesNormally(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		if _, _, err = conn.ReadMessage(); err != nil {
			t.Error(err)
			return
		}
		if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed","response":{"id":"resp_done","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`)); err != nil {
			t.Error(err)
			return
		}
		_ = conn.UnderlyingConn().Close()
	}))
	defer upstream.Close()

	internalClient, err := cpa.New(upstream.URL, "embedded-test-key", "", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	app := &App{cfg: config.Config{CPAMaxRequestBytes: 1 << 20}, nativeCPA: internalClient}
	resultCh := make(chan nativeWebSocketTestResult, 1)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "codex"}}
		session, _, err := app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "completed-eof-test", nil, accounting)
		resultCh <- nativeWebSocketTestResult{session: session, err: err}
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-test"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = client.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	_, _, err = client.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("close error = %v, want normal closure", err)
	}
	select {
	case got := <-resultCh:
		if got.err != nil || !got.session.established {
			t.Fatalf("session = %+v, error = %v", got.session, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for websocket relay")
	}
}

func TestClientWebSocketDisconnectRejectsServiceErrors(t *testing.T) {
	if !clientWebSocketDisconnect(&websocket.CloseError{Code: websocket.CloseAbnormalClosure, Text: "unexpected EOF"}) {
		t.Fatal("abnormal peer close should be classified as a client disconnect")
	}
	if clientWebSocketDisconnect(errors.New("upstream unavailable")) {
		t.Fatal("service error should not be classified as a client disconnect")
	}
}

func TestNativeResponsesWebSocketUsesEmbeddedCPAHandlerAndAccountsUsage(t *testing.T) {
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

	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: mustJSON(t, map[string]any{
			"type": "codex", "access_token": "upstream-token", "base_url": upstream.URL, "websockets": true,
			"model_routes": []map[string]any{{"public": "gpt-test", "upstream": "gpt-upstream"}},
		}),
	})
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "codex"}}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "request-test", nil, accounting)
		accountingCh <- accounting.result
	}))
	defer downstream.Close()

	headers := http.Header{
		"OpenAI-Beta":                            []string{"responses_websockets=2026-02-06"},
		"X-OpenAI-Internal-Codex-Responses-Lite": []string{"true"},
	}
	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteJSON(map[string]any{
		"type": "response.create", "model": "gpt-test", "input": []any{}, "parallel_tool_calls": true,
	}); err != nil {
		t.Fatal(err)
	}
	_, response, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err = json.Unmarshal(response, &event); err != nil || event["type"] != "response.completed" {
		t.Fatalf("downstream event = %s, error = %v", response, err)
	}
	_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))

	select {
	case got := <-observedCh:
		if got.Authorization != "Bearer upstream-token" {
			t.Fatalf("authorization = %q", got.Authorization)
		}
		if got.Beta != "responses_websockets=2026-02-06" {
			t.Fatalf("OpenAI-Beta = %q", got.Beta)
		}
		if got.Body["type"] != "response.create" || got.Body["model"] != "gpt-upstream" || got.Body["parallel_tool_calls"] != false {
			t.Fatalf("upstream body = %#v", got.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for embedded CPA upstream request")
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

func TestNativeResponsesWebSocketLeavesMultiTurnStateToEmbeddedCPA(t *testing.T) {
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
				"type": "response.completed", "response": map[string]any{
					"id": "resp_" + string(rune('0'+i)), "status": "completed", "output": []any{},
					"usage": map[string]any{"input_tokens": i, "output_tokens": 1, "total_tokens": i + 1},
				},
			})
		}
		_, _, _ = conn.ReadMessage()
	}))
	defer upstream.Close()

	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: mustJSON(t, map[string]any{
			"type": "codex", "access_token": "token", "base_url": upstream.URL, "websockets": true,
			"model_routes": []map[string]any{{"public": "gpt-test", "upstream": "gpt-upstream"}},
		}),
	})
	accountingCh := make(chan billing.Result, 1)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "codex"}}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "session-test", nil, accounting)
		accountingCh <- accounting.result
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-test", "input": []any{}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = client.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	if err = client.WriteJSON(map[string]any{
		"type": "response.create", "previous_response_id": "resp_1", "input": []any{},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = client.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))

	first, second := <-requests, <-requests
	if first["type"] != "response.create" || first["model"] != "gpt-upstream" || second["type"] != "response.create" || second["previous_response_id"] != "resp_1" {
		t.Fatalf("upstream requests = %#v, %#v", first, second)
	}
	if connections.Load() != 1 {
		t.Fatalf("upstream websocket connections = %d, want 1", connections.Load())
	}
	select {
	case got := <-accountingCh:
		if got.Usage.Prompt != 3 || got.Usage.Completion != 2 || got.Usage.Total != 5 {
			t.Fatalf("multi-turn accounting = %#v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for multi-turn accounting")
	}
}

func TestNativeResponsesWebSocketPreservesEmbeddedCPAPrewarm(t *testing.T) {
	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "compat", Provider: "openai", Enabled: true, Models: []string{"gpt-test"},
		Document: []byte(`{"type":"openai","api_key":"unused","base_url":"https://example.invalid/v1"}`),
	})
	accountingCh := make(chan billing.Result, 1)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accounting := &nativeWebSocketAccounting{billable: true, admission: store.Admission{CPAAuthID: "compat"}}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "prewarm-test", nil, accounting)
		accountingCh <- accounting.result
	}))
	defer downstream.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteJSON(map[string]any{
		"type": "response.create", "model": "gpt-test", "generate": false, "input": []any{},
	}); err != nil {
		t.Fatal(err)
	}
	completed := false
	for i := 0; i < 3 && !completed; i++ {
		_, payload, readErr := client.ReadMessage()
		if readErr != nil {
			t.Fatal(readErr)
		}
		var event struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(payload, &event)
		completed = event.Type == "response.completed"
	}
	if !completed {
		t.Fatal("embedded CPA did not synthesize the websocket prewarm completion")
	}
	_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	select {
	case got := <-accountingCh:
		if !got.Found || got.Usage.Total != 0 {
			t.Fatalf("prewarm accounting = %#v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for prewarm accounting")
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

func newEmbeddedCPATestApp(t *testing.T, credential relaybridge.Credential) *App {
	t.Helper()
	runtime, err := relaybridge.NewRuntime(relaybridge.Options{APIKey: "embedded-test-key"}, []relaybridge.Credential{credential})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(runtime.Handler())
	client, err := cpa.New(server.URL, "embedded-test-key", "", time.Minute)
	if err != nil {
		server.Close()
		_ = runtime.Close(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		server.Close()
		_ = runtime.Close(context.Background())
	})
	return &App{cfg: config.Config{CPAMaxRequestBytes: 1 << 20}, nativeCPA: client, nativeCPARuntime: runtime}
}

func TestNativeWebSocketAdmissionErrorPreservesQuotaStatus(t *testing.T) {
	status, code := nativeWebSocketAdmissionError("subscription_quota_exceeded")
	if status != http.StatusTooManyRequests || code != "subscription_quota_exceeded" {
		t.Fatalf("status/code = %d/%q", status, code)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
