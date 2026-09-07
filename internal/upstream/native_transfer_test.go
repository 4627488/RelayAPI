package upstream

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRuntimeCompletionIncludesResponseBody(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(20 * time.Millisecond)
		_, _ = io.WriteString(w, `{"id":"resp_ok","output":[]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Relay-Request-ID", "transfer-1")
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	trace, ok := runtime.TakeRequestTrace("transfer-1")
	if !ok {
		t.Fatal("missing trace")
	}
	if len(trace.Attempts) != 1 || trace.Attempts[0].Kind != "headers" {
		t.Fatalf("missing measured header attempt: %+v", trace)
	}
	if trace.CompletedAt.Sub(trace.Attempts[0].CompletedAt) < 15*time.Millisecond {
		t.Fatalf("response boundary excluded the delayed body: %+v", trace)
	}
	if !strings.Contains(recorder.Body.String(), "resp_ok") {
		t.Fatal("response body lost")
	}
}
