package app

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestSanitizedHeadersRedactsSecrets(t *testing.T) {
	headers := http.Header{
		"Authorization": {"Bearer secret"}, "Cookie": {"session=secret"},
		"X-Goog-Api-Key": {"relay_gemini_secret"},
		"X-Request-ID":   {"visible"},
	}
	value := sanitizedHeaders(headers)
	if strings.Contains(value, "Bearer secret") || strings.Contains(value, "session=secret") || strings.Contains(value, "relay_gemini_secret") {
		t.Fatalf("sensitive value leaked: %s", value)
	}
	if !strings.Contains(value, "visible") || !strings.Contains(value, "[REDACTED]") {
		t.Fatalf("unexpected sanitized headers: %s", value)
	}
}

func TestBoundedDetailReportsOriginalSize(t *testing.T) {
	payload := []byte(strings.Repeat("a", requestLogDetailLimit+17))
	value, truncated, size := boundedDetail(payload)
	if !truncated || len(value) != requestLogDetailLimit || size != int64(len(payload)) {
		t.Fatalf("value=%d truncated=%v size=%d", len(value), truncated, size)
	}
}

func TestBoundedDetailNeverReturnsInvalidUTF8(t *testing.T) {
	payload := append([]byte(strings.Repeat("a", requestLogDetailLimit-1)), []byte("中文")...)
	value, truncated, size := boundedDetail(payload)
	if !truncated || !utf8.ValidString(value) || size != int64(len(payload)) {
		t.Fatalf("valid=%v truncated=%v size=%d", utf8.ValidString(value), truncated, size)
	}
	if strings.HasSuffix(value, "�") {
		t.Fatalf("a rune split at the byte limit: %q", value[len(value)-4:])
	}

	value, truncated, _ = boundedDetail([]byte{'a', 0xff, 'b'})
	if truncated || !utf8.ValidString(value) || value != "a�b" {
		t.Fatalf("invalid input was not normalized: %q", value)
	}
}

func TestSampledRequestIsDeterministicAndHonorsBounds(t *testing.T) {
	if sampledRequest("request", 0) {
		t.Fatal("zero sampling rate retained a request")
	}
	if !sampledRequest("request", 1_000_000) {
		t.Fatal("full sampling rate dropped a request")
	}
	first := sampledRequest("stable-request-id", 10_000)
	for index := 0; index < 10; index++ {
		if sampledRequest("stable-request-id", 10_000) != first {
			t.Fatal("sampling decision changed for the same request")
		}
	}
}

func TestShouldRetainRequestDetail(t *testing.T) {
	if shouldRetainRequestDetail("success", http.StatusOK, "", 0) {
		t.Fatal("successful request detail should be disabled at zero sampling")
	}
	if !shouldRetainRequestDetail("error", http.StatusBadGateway, "upstream_http_error", 0) {
		t.Fatal("HTTP error detail must be retained")
	}
	if !shouldRetainRequestDetail("websocket-error", http.StatusSwitchingProtocols, "websocket_session_error", 0) {
		t.Fatal("protocol error detail must be retained even with a success-class status")
	}
	if !shouldRetainRequestDetail("sampled", http.StatusOK, "", 1_000_000) {
		t.Fatal("successful request detail should honor explicit sampling")
	}
}

func TestCaptureForwardedRequestDoesNotDuplicateIdenticalBody(t *testing.T) {
	detail := &store.LogDetailInput{}
	body := []byte(`{"model":"gpt-test"}`)
	captureForwardedRequest(detail, body, body)
	if detail.ForwardedBody != "" || detail.ForwardedBodyBytes != int64(len(body)) {
		t.Fatalf("identical forwarded body was retained: %#v", detail)
	}

	rewritten := []byte(`{"model":"gpt-upstream"}`)
	captureForwardedRequest(detail, body, rewritten)
	if detail.ForwardedBody != string(rewritten) || detail.ForwardedBodyBytes != int64(len(rewritten)) {
		t.Fatalf("rewritten forwarded body was not retained: %#v", detail)
	}
}

func TestRequestTypeRecognizesSupportedSurfaces(t *testing.T) {
	tests := map[string]string{
		"/v1/responses":        "responses",
		"/v1/chat/completions": "chat.completions",
	}
	for path, expected := range tests {
		if got := requestType(path, false); got != expected {
			t.Fatalf("requestType(%q) = %q, want %q", path, got, expected)
		}
	}
	if got := requestType("/v1/responses/ws", true); got != "responses.websocket" {
		t.Fatalf("websocket request type = %q", got)
	}
}

func TestUpstreamErrorMessageExtractsStructuredMessage(t *testing.T) {
	got := upstreamErrorMessage(http.StatusBadRequest, []byte(`{"error":{"message":"invalid model"}}`))
	if got != "invalid model" {
		t.Fatalf("message = %q", got)
	}
}

func TestBoundedErrorTextNeverReturnsInvalidUTF8(t *testing.T) {
	value := boundedErrorText(strings.Repeat("中", 1_000))
	if len(value) > 2048 || !utf8.ValidString(value) {
		t.Fatalf("length=%d valid=%v", len(value), utf8.ValidString(value))
	}
	if strings.HasSuffix(value, "�") {
		t.Fatalf("a rune split at the byte limit: %q", value[len(value)-4:])
	}

	value = boundedErrorText(string([]byte{'a', 0xff, 'b'}))
	if !utf8.ValidString(value) || value != "a�b" {
		t.Fatalf("invalid input was not normalized: %q", value)
	}
}

func TestMaybeCaptureForwardedRequestSkipsSuccessfulUnsampledBodies(t *testing.T) {
	app := &App{cfg: config.Config{RequestSuccessSamplePPM: 0}}
	req, err := http.NewRequest(http.MethodPost, "/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret")
	body := []byte(strings.Repeat(`{"model":"gpt-test","prompt":"x"}`, 200))
	logContext := requestLogContext{requestBytes: int64(len(body))}
	app.maybeCaptureForwardedRequest(&logContext, req, body, body, req.Header, "success-id", http.StatusOK, "")
	if logContext.detail != nil {
		t.Fatalf("unsampled success copied request detail: %+v", logContext.detail)
	}
	if logContext.forwardedBytes != int64(len(body)) {
		t.Fatalf("forwarded bytes = %d", logContext.forwardedBytes)
	}

	app.maybeCaptureForwardedRequest(&logContext, req, body, body, req.Header, "error-id", http.StatusBadGateway, "upstream_http_error")
	if logContext.detail == nil || logContext.detail.RequestBody == "" || !strings.Contains(logContext.detail.RequestHeaders, "[REDACTED]") {
		t.Fatalf("error path must retain sanitized request detail: %+v", logContext.detail)
	}

	logContext = requestLogContext{requestBytes: int64(len(body))}
	logContext.maybeCaptureUpstream(http.StatusOK, http.Header{"X-Upstream-TRACE-ID": []string{"trace"}}, []byte(`{"ok":true}`), false, 11, false)
	if logContext.detail != nil || logContext.responseBytes != 11 {
		t.Fatalf("unsampled upstream capture = detail=%v bytes=%d", logContext.detail, logContext.responseBytes)
	}
}

func TestCaptureWebSocketRequestStoresFirstFrame(t *testing.T) {
	detail := &store.LogDetailInput{}
	captureWebSocketRequest(detail, []byte(`{"type":"response.create","model":"gpt-5.6"}`))
	if !strings.Contains(detail.RequestBody, "response.create") || detail.RequestBodyBytes == 0 || detail.RequestBodyTruncated {
		t.Fatalf("captured websocket request = %+v", detail)
	}
}
