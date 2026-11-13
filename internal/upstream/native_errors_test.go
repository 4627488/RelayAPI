package upstream

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderErrorIdentifiesSourceAndPreservesFields(t *testing.T) {
	for _, body := range []string{
		`{"error":{"code":"quota_exceeded","type":"quota_error","message":"Quota exhausted","param":"model"},"request_id":"req-1"}`,
		`{"error":"Quota exhausted"}`,
		`{"message":"Quota exhausted"}`,
		`<html>gateway failure</html>`,
		strings.Repeat("x", 65537),
	} {
		t.Run(body[:min(len(body), 40)], func(t *testing.T) {
			response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{
				"Retry-After": {"30"}, "Content-Length": {"123"}, "Content-Type": {"text/html"},
			}, Body: io.NopCloser(strings.NewReader(body))}
			w := httptest.NewRecorder()
			writeProviderError(w, response)
			var root map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
				t.Fatal(err)
			}
			value := root["error"].(map[string]any)
			if w.Code != 429 || w.Header().Get("Retry-After") != "30" || w.Header().Get("Content-Length") != "" || w.Header().Get("X-Relay-Error-Source") != "upstream" {
				t.Fatalf("status/headers = %d %v", w.Code, w.Header())
			}
			if value["source"] != "upstream" || !strings.HasPrefix(value["message"].(string), "Upstream service error: ") || strings.Contains(w.Body.String(), "<html>") {
				t.Fatalf("error = %s", w.Body.String())
			}
			if strings.Contains(body, "quota_exceeded") && (value["code"] != "quota_exceeded" || value["param"] != "model" || root["request_id"] != "req-1") {
				t.Fatalf("provider fields lost: %s", w.Body.String())
			}
		})
	}
}

func TestRuntimeErrorsDistinguishRelayAndUpstream(t *testing.T) {
	for _, code := range []string{"invalid_request", "model_account_unavailable", "upstream_connection_failed", "upstream_response_invalid"} {
		w := httptest.NewRecorder()
		writeRuntimeError(w, 502, code, "test failure")
		want := "relay"
		if strings.HasPrefix(code, "upstream_") {
			want = "upstream"
		}
		if w.Header().Get("X-Relay-Error-Source") != want {
			t.Fatalf("%s: source = %q", code, w.Header().Get("X-Relay-Error-Source"))
		}
	}
}

func TestUpstreamAuthenticationFailureDoesNotInvalidateRelayKey(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		w := httptest.NewRecorder()
		writeProviderError(w, &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"account_suspended","message":"This upstream account cannot serve the request."}}`))})
		var root map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
			t.Fatal(err)
		}
		value := root["error"].(map[string]any)
		if w.Code != http.StatusBadGateway || value["upstream_status"] != float64(status) || value["code"] != "account_suspended" || w.Header().Get("X-Should-Retry") != "false" {
			t.Fatalf("upstream authentication exposed as caller failure: %d %s", w.Code, w.Body.String())
		}
	}
}
