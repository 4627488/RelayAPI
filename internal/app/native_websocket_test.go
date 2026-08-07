package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

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
		_ = conn.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp_test"}})
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
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, store.Admission{}, requestMeta{}, "request-test")
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
}
