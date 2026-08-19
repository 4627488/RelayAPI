package upstream

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gorilla/websocket"
)

func TestDialWebSocketHandsFramesToHandler(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Relay-Request-ID") != "req-1" || r.URL.Path != "/v1/responses" {
			http.Error(w, "bad handshake", http.StatusBadRequest)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var event map[string]any
		if json.Unmarshal(payload, &event) != nil {
			return
		}
		_ = conn.WriteJSON(map[string]any{"type": "response.completed", "echo": event["type"]})
	})
	conn, response, err := DialWebSocket(t.Context(), handler, "/v1/responses", http.Header{
		"X-Relay-Request-ID": []string{"req-1"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	defer conn.Close()
	if err = conn.WriteJSON(map[string]any{"type": "response.create"}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err = conn.ReadJSON(&reply); err != nil || reply["echo"] != "response.create" {
		t.Fatalf("reply = %#v, err = %v", reply, err)
	}
}
