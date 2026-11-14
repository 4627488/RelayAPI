package upstream

import (
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gorilla/websocket"
)

func TestProviderWebSocketIsolatesHTTP2ALPN(t *testing.T) {
	provider := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !websocket.IsWebSocketUpgrade(r) {
			if r.ProtoMajor != 2 {
				t.Errorf("ordinary HTTPS lost HTTP/2: %s", r.Proto)
			}
			_, _ = io.WriteString(w, "ok")
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed"}`))
	}))
	provider.EnableHTTP2 = true
	provider.StartTLS()
	defer provider.Close()

	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true,
		Models: []string{"model"}, Document: testJSON(t, map[string]any{
			"api_key": "test", "base_url": provider.URL, "websockets": true,
		})}).(*nativeRuntime)
	credential := runtime.credentials["codex"]
	credential.client = provider.Client()
	transport := credential.client.Transport.(*http.Transport)
	// Reproduce the production ordering: net/http initializes HTTP/2 before
	// WebSocket borrows this account's proxy, dialer and TLS trust settings.
	response, err := credential.client.Get(provider.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	before := append([]string(nil), transport.TLSClientConfig.NextProtos...)
	conn, response, err := credential.dialWebSocket(t.Context(), "/v1/responses", nil)
	if err != nil {
		t.Fatalf("WSS after HTTP/2 request: %v", err)
	}
	defer conn.Close()
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, transport.TLSClientConfig.NextProtos) {
		t.Fatal("WSS modified the shared HTTP transport's ALPN")
	}
}
