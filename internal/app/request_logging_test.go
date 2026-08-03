package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestSanitizedHeadersRedactsSecrets(t *testing.T) {
	headers := http.Header{
		"Authorization": {"Bearer secret"}, "Cookie": {"session=secret"},
		"X-Request-ID": {"visible"},
	}
	value := sanitizedHeaders(headers)
	if strings.Contains(value, "Bearer secret") || strings.Contains(value, "session=secret") {
		t.Fatalf("sensitive value leaked: %s", value)
	}
	if !strings.Contains(value, "visible") || !strings.Contains(value, "[REDACTED]") {
		t.Fatalf("unexpected sanitized headers: %s", value)
	}
}

func TestClassifyCPATransportError(t *testing.T) {
	tests := []struct {
		name, message, code string
		err                 error
		requestErr          error
		status              int
	}{
		{name: "client canceled", err: context.Canceled, requestErr: context.Canceled, code: "client_canceled", status: 499},
		{name: "timeout", err: context.DeadlineExceeded, code: "cpa_timeout", status: http.StatusGatewayTimeout},
		{name: "reset", err: errors.New("read: connection reset by peer"), code: "cpa_connection_lost", status: http.StatusServiceUnavailable},
		{name: "unexpected eof", err: errors.New("unexpected EOF"), code: "cpa_connection_lost", status: http.StatusServiceUnavailable},
		{name: "refused", err: errors.New("dial tcp: connection refused"), code: "cpa_unavailable", status: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := classifyCPATransportError(test.err, test.requestErr, "models")
			if got.Code != test.code || got.Status != test.status || got.Phase != "models" {
				t.Fatalf("classification = %+v", got)
			}
		})
	}
}

func TestBoundedDetailReportsOriginalSize(t *testing.T) {
	payload := []byte(strings.Repeat("a", requestLogDetailLimit+17))
	value, truncated, size := boundedDetail(payload)
	if !truncated || len(value) != requestLogDetailLimit || size != int64(len(payload)) {
		t.Fatalf("value=%d truncated=%v size=%d", len(value), truncated, size)
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

func TestRequestTypeRecognizesSupportedSurfaces(t *testing.T) {
	tests := map[string]string{
		"/v1/responses":        "responses",
		"/v1/chat/completions": "chat.completions",
		"/v1/messages":         "messages",
		"/v1beta/models/gemini:streamGenerateContent": "gemini.streamGenerateContent",
	}
	for path, expected := range tests {
		if got := requestType(path); got != expected {
			t.Fatalf("requestType(%q) = %q, want %q", path, got, expected)
		}
	}
}

func TestUpstreamErrorMessageExtractsStructuredMessage(t *testing.T) {
	got := upstreamErrorMessage(http.StatusBadRequest, []byte(`{"error":{"message":"invalid model"}}`))
	if got != "invalid model" {
		t.Fatalf("message = %q", got)
	}
}
