package relaybridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Exercise the embedded router as well as CPA's translators and executor.
func TestRuntimeCodexFastPassthrough(t *testing.T) {
	for _, endpoint := range []struct{ path, fields string }{
		{"/v1/responses", `"service_tier":"priority","input":"hi"`},
		{"/v1/responses", `"service_tier":"fast","input":"hi"`},
		{"/v1/chat/completions", `"service_tier":"priority","messages":[{"role":"user","content":"hi"}]`},
		{"/v1/messages", `"speed":"fast","max_tokens":32,"messages":[{"role":"user","content":"hi"}]`},
	} {
		for _, stream := range []bool{false, true} {
			for _, actual := range []string{"priority", "default"} {
				t.Run(fmt.Sprintf("%s/%s/stream=%v/actual=%s", endpoint.path, endpoint.fields, stream, actual), func(t *testing.T) {
					runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{ID: "codex-fast", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"}, Document: []byte(`{"type":"codex","access_token":"test-token"}`)}})
					if err != nil {
						t.Fatal(err)
					}
					defer runtime.Close(context.Background())
					requests := 0
					runtime.manager.SetRoundTripperProvider(grokHeaderTransport(func(r *http.Request) (*http.Response, error) {
						requests++
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Fatal(err)
						}
						if body["service_tier"] != "priority" || r.Header.Get("X-Codex-Routing-Hint") != "model=gpt-5.4;tier=priority" {
							t.Errorf("body tier=%v routing hint=%q", body["service_tier"], r.Header.Get("X-Codex-Routing-Hint"))
						}
						payload := fmt.Sprintf("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fast\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"service_tier\":%q,\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n", actual)
						return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
					}))
					request := httptest.NewRequest(http.MethodPost, endpoint.path, strings.NewReader(fmt.Sprintf(`{"model":"gpt-5.4","stream":%v,%s}`, stream, endpoint.fields)))
					request.Header.Set("Authorization", "Bearer internal-test-key")
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("X-Codex-Routing-Hint", "model=old;tier=default")
					response := httptest.NewRecorder()
					runtime.Handler().ServeHTTP(response, request)
					if response.Code != http.StatusOK || requests != 1 {
						t.Fatalf("response=%d %s requests=%d", response.Code, response.Body.String(), requests)
					}
					// Claude's response schema has no service_tier field.
					if endpoint.path != "/v1/messages" && !strings.Contains(response.Body.String(), `"service_tier":"`+actual+`"`) {
						t.Fatalf("actual tier lost: %s", response.Body.String())
					}
				})
			}
		}
	}
}
