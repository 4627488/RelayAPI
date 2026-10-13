package upstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
)

func TestCodexFastHTTPPassthrough(t *testing.T) {
	for _, path := range []string{"/v1/responses", "/v1/chat/completions"} {
		for _, stream := range []bool{false, true} {
			for _, actualTier := range []string{"priority", "default"} {
				t.Run(fmt.Sprintf("%s/stream=%v/actual=%s", path, stream, actualTier), func(t *testing.T) {
					provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						var body map[string]any
						_ = json.NewDecoder(r.Body).Decode(&body)
						if body["service_tier"] != "priority" || r.Header.Get("X-Codex-Routing-Hint") != "model=gpt-5.4;tier=priority" {
							t.Errorf("upstream body=%v hint=%q", body, r.Header.Get("X-Codex-Routing-Hint"))
						}
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fast\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"service_tier\":%q,\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", actualTier)
					}))
					defer provider.Close()
					runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"}, Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL})})
					request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(fmt.Sprintf(`{"model":"gpt-5.4","service_tier":"priority","stream":%v,"input":"hi","messages":[{"role":"user","content":"hi"}]}`, stream)))
					request.Header.Set("X-Codex-Routing-Hint", "model=stale-alias;tier=default")
					response := httptest.NewRecorder()
					runtime.Handler().ServeHTTP(response, request)
					if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"service_tier":"`+actualTier+`"`) {
						t.Fatalf("response=%d %s", response.Code, response.Body.String())
					}
				})
			}
		}
	}
}

func TestCodexFastWebSocketPassthrough(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Codex-Routing-Hint") != "model=gpt-5.4;tier=priority" {
			t.Errorf("hint=%q", r.Header.Get("X-Codex-Routing-Hint"))
		}
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var frame map[string]any
		if err := conn.ReadJSON(&frame); err != nil {
			return
		}
		if frame["service_tier"] != "priority" {
			t.Errorf("frame=%v", frame)
		}
		_ = conn.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"service_tier": "priority"}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"}, Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL, "websockets": true})})
	conn, _, err := DialWebSocket(t.Context(), runtime.Handler(), "/v1/responses", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]any{"type": "response.create", "model": "gpt-5.4", "service_tier": "priority", "input": []any{}}); err != nil {
		t.Fatal(err)
	}
	_, payload, err := conn.ReadMessage()
	if err != nil || gjson.GetBytes(payload, "response.service_tier").String() != "priority" {
		t.Fatalf("reply=%s err=%v", payload, err)
	}
}

func TestChatToResponsesPreservesActualServiceTier(t *testing.T) {
	for _, tier := range []string{"priority", "default"} {
		payload := []byte(fmt.Sprintf(`{"id":"chat_1","service_tier":%q,"choices":[]}`, tier))
		if got := gjson.GetBytes(chatToResponsesResponse(payload, "model"), "service_tier").String(); got != tier {
			t.Fatalf("tier=%q", got)
		}
		var output bytes.Buffer
		stream := fmt.Sprintf("data: {\"id\":\"chat_1\",\"service_tier\":%q,\"choices\":[]}\n\ndata: [DONE]\n\n", tier)
		if err := translateChatStreamToResponses(&output, strings.NewReader(stream), "model"); err != nil {
			t.Fatal(err)
		}
		completed := completedResponseFromPayload(output.Bytes())
		if got := gjson.GetBytes(completed, "service_tier").String(); got != tier {
			t.Fatalf("tier=%q stream=%s", got, output.String())
		}
	}
}

func TestCodexRoutingHintDefaultsAndOverrides(t *testing.T) {
	for _, tc := range []struct {
		name, provider, apiKey, override, body, want string
	}{
		{"normal", "codex", "", "", `{"model":"resolved"}`, "model=resolved"},
		{"explicit tier", "codex", "", "", `{"model":"resolved","service_tier":"flex"}`, "model=resolved;tier=flex"},
		{"operator override", "codex", "", "operator", `{"model":"resolved","service_tier":"priority"}`, "operator"},
		{"api key", "codex", "key", "", `{"model":"resolved"}`, "client"},
		{"other provider", "openai", "", "", `{"model":"resolved"}`, "client"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credential := &nativeCredential{Provider: tc.provider, APIKey: tc.apiKey, Headers: make(http.Header)}
			credential.Headers.Set("X-Codex-Routing-Hint", tc.override)
			header := make(http.Header)
			header.Set("X-Codex-Routing-Hint", "client")
			credential.applyCodexRoutingHint(header, []byte(tc.body))
			if got := header.Get("X-Codex-Routing-Hint"); got != tc.want {
				t.Fatalf("hint=%q want=%q", got, tc.want)
			}
		})
	}
}
