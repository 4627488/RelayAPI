package relaybridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGeminiNativeAndOpenAITranslationUseCPA(t *testing.T) {
	for _, path := range []string{"/v1beta/models/gemini-2.5-flash:generateContent", "/v1beta/models/gemini-2.5-flash:streamGenerateContent", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{ID: "gemini-test", Provider: "gemini", Enabled: true, Models: []string{"gemini-2.5-flash"}, Document: []byte(`{"type":"gemini","api_key":"upstream-key"}`)}})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close(context.Background())
			calls := 0
			runtime.manager.SetRoundTripperProvider(grokHeaderTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), `"contents"`) || strings.Contains(string(body), "internal-test-key") {
					t.Errorf("Gemini translation = %s", body)
				}
				payload := `{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12},"modelVersion":"gemini-2.5-flash"}`
				contentType := "application/json"
				if strings.Contains(r.URL.Path, "streamGenerateContent") {
					payload = "data: " + payload + "\n\n"
					contentType = "text/event-stream"
				}
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
			}))
			body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
			if path == "/v1/chat/completions" {
				body = `{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}`
			}
			if path == "/v1/responses" {
				body = `{"model":"gemini-2.5-flash","input":"hi"}`
			}
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer internal-test-key")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Relay-CPA-Auth-ID", "gemini-test")
			response := httptest.NewRecorder()
			runtime.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK || calls != 1 || !strings.Contains(response.Body.String(), "pong") {
				t.Fatalf("Gemini %s = %d %s; attempts %d", path, response.Code, response.Body.String(), calls)
			}
		})
	}
}
