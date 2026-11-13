package upstream

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Magpie consumes incremental tool events. The first event must reach it before
// the generation ends, and closing its request must stop the upstream too.
func TestResponsesToolStreamFlushesAndCancelsUpstream(t *testing.T) {
	canceled := make(chan struct{})
	event := `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":\"a.go\"}"}` + "\n\n"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, event)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "upstream-key", "base_url": provider.URL})})
	relay := httptest.NewServer(runtime.Handler())
	defer relay.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, relay.URL+"/v1/responses", strings.NewReader(`{"model":"model","stream":true,"input":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	response, err := relay.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != strings.TrimSuffix(event, "\n") {
		t.Fatalf("incremental tool event = %q, err=%v", line, err)
	}
	cancel()
	_ = response.Body.Close()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("closing the Magpie stream left its upstream generation running")
	}
	credential := runtime.(*nativeRuntime).credentials["codex"]
	credential.mu.Lock()
	defer credential.mu.Unlock()
	if credential.Status.Failed != 0 || credential.Status.Unavailable {
		t.Fatalf("client cancellation damaged credential health: %+v", credential.Status)
	}
}

func TestResponsesCanceledBeforeHeadersDoesNotCoolAccount(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "key", "base_url": provider.URL})})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		runtime.Serve(w, request, []byte(`{"model":"model","input":[],"stream":true}`))
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream did not receive request")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("canceled request did not return")
	}
	if w.Code != 499 || w.Header().Get("X-Should-Retry") != "false" {
		t.Fatalf("cancellation response: %d %s", w.Code, w.Body.String())
	}
	credential := runtime.(*nativeRuntime).credentials["codex"]
	credential.mu.Lock()
	defer credential.mu.Unlock()
	if credential.Status.Failed != 0 || credential.Status.Unavailable {
		t.Fatalf("client cancellation damaged credential health: %+v", credential.Status)
	}
}

func TestResponsesWebSocketRefreshesBeforeGeneration(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected-handshake", true: "expired-token"}[expired], func(t *testing.T) {
			var refreshes, handshakes atomic.Int32
			oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				refreshes.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"access_token":"fresh","refresh_token":"rotated","expires_in":3600}`)
			}))
			defer oauth.Close()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handshakes.Add(1)
				if r.Header.Get("Authorization") != "Bearer fresh" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err == nil {
					_ = conn.Close()
				}
			}))
			defer provider.Close()
			expires := time.Now().Add(time.Hour)
			if expired {
				expires = time.Now().Add(-time.Hour)
			}
			runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"access_token": "stale", "refresh_token": "refresh", "expired": expires.Format(time.RFC3339), "base_url": provider.URL, "token_endpoint": oauth.URL, "websockets": true})}).(*nativeRuntime)
			conn, response, err := runtime.dialProviderWebSocket(t.Context(), runtime.credentials["codex"], "/v1/responses", make(http.Header))
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
			if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}
			wantHandshakes := int32(2)
			if expired {
				wantHandshakes = 1
			}
			if refreshes.Load() != 1 || handshakes.Load() != wantHandshakes {
				t.Fatalf("refreshes=%d handshakes=%d", refreshes.Load(), handshakes.Load())
			}
		})
	}
}

func TestResponsesRevokedRefreshStopsBeforeGeneration(t *testing.T) {
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
	}))
	defer oauth.Close()
	var generations atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		generations.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"access_token": "stale", "refresh_token": "revoked", "expired": time.Now().Add(-time.Hour).Format(time.RFC3339), "base_url": provider.URL, "token_endpoint": oauth.URL})})
	w := httptest.NewRecorder()
	runtime.Serve(w, httptest.NewRequest(http.MethodPost, "/v1/responses", nil), []byte(`{"model":"model","input":[]}`))
	if w.Code != http.StatusBadGateway || w.Header().Get("X-Should-Retry") != "false" || w.Header().Get("X-Relay-Error-Code") != "model_account_auth_failed" || w.Header().Get("X-Relay-Error-Source") != "upstream" || generations.Load() != 0 {
		t.Fatalf("refresh rejection was retried or blamed on the Relay key: %d %s, generations=%d", w.Code, w.Body.String(), generations.Load())
	}
}

func TestResponsesWebSocketPreservesToolContinuation(t *testing.T) {
	requests := []string{
		`{"type":"response.create","model":"model","input":"read a.go","store":true,"max_output_tokens":123,"unknown_future_field":{"keep":true}}`,
		`{"type":"response.create","model":"model","previous_response_id":"resp_tool","input":[{"type":"function_call_output","call_id":"call_1","output":"package main"}]}`,
	}
	replies := []string{
		`{"type":"response.completed","response":{"id":"resp_tool","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a.go\"}"}]}}`,
		`{"type":"response.completed","response":{"id":"resp_final","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"It is a Go file."}]}]}}`,
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for index, want := range requests {
			_, got, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("turn %d: %v", index, err)
				return
			}
			if string(got) != want {
				t.Errorf("turn %d was rewritten: %s", index, got)
			}
			_ = conn.WriteMessage(websocket.TextMessage, []byte(replies[index]))
		}
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "key", "base_url": provider.URL, "websockets": true})})
	conn, _, err := DialWebSocket(t.Context(), runtime.Handler(), "/v1/responses", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for index, request := range requests {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(request)); err != nil {
			t.Fatal(err)
		}
		_, got, err := conn.ReadMessage()
		if err != nil || string(got) != replies[index] {
			t.Fatalf("tool continuation turn %d: %s, err=%v", index, got, err)
		}
	}
}

func TestResponsesWebSocketTransportRefusalDoesNotCoolAccount(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUpgradeRequired) }))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "key", "base_url": provider.URL, "websockets": true})}).(*nativeRuntime)
	conn, _, err := DialWebSocket(t.Context(), runtime.Handler(), "/v1/responses", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"model","input":[]}`))
	_, payload, err := conn.ReadMessage()
	if err != nil || !bytes.Contains(payload, []byte("upstream_websocket_failed")) {
		t.Fatalf("transport error: %s %v", payload, err)
	}
	credential := runtime.credentials["codex"]
	credential.mu.Lock()
	defer credential.mu.Unlock()
	if credential.Status.Failed != 0 || credential.Status.Unavailable {
		t.Fatalf("HTTP-capable account cooled by socket refusal: %+v", credential.Status)
	}
}

func TestResponsesWebSocketUsesEachTurnsModelRoute(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("Codex website query leaked into an API-key endpoint: %s", r.URL.RawQuery)
		}
		if r.Header.Get("OpenAI-Beta") != "responses_websockets=2026-02-06" {
			t.Errorf("wrong websocket beta: %s", r.Header.Get("OpenAI-Beta"))
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for _, want := range []string{"upstream-one", "upstream-two"} {
			var frame map[string]any
			if err = conn.ReadJSON(&frame); err != nil {
				t.Error(err)
				return
			}
			if frame["model"] != want {
				t.Errorf("model changed to wrong route: %+v", frame)
			}
			_ = conn.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"id": want, "output": []any{}}})
		}
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"one", "two"}, Document: testJSON(t, map[string]any{"api_key": "key", "base_url": provider.URL, "websockets": true, "model_routes": []map[string]string{{"public": "one", "upstream": "upstream-one"}, {"public": "two", "upstream": "upstream-two"}}})})
	conn, _, err := DialWebSocket(t.Context(), runtime.Handler(), "/v1/responses", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for _, model := range []string{"one", "two"} {
		if err = conn.WriteJSON(map[string]any{"type": "response.create", "model": model, "input": []any{}}); err != nil {
			t.Fatal(err)
		}
		if _, _, err = conn.ReadMessage(); err != nil {
			t.Fatal(err)
		}
	}
}
