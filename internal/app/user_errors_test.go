package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestObservedErrorKeepsProviderPayload(t *testing.T) {
	code, message := observedError(http.StatusTooManyRequests, []byte(`{"error":{"code":"rate_limit_exceeded","message":"too many requests"}}`))
	if code != "rate_limit_exceeded" || message != "too many requests" {
		t.Fatalf("observed = %s %q", code, message)
	}
	code, message = observedError(http.StatusUnauthorized, []byte(`{"error":{"message":"token expired"}}`))
	if code != "upstream_http_error" || message != "token expired" {
		t.Fatalf("message-only payload = %s %q", code, message)
	}
	code, message = observedError(http.StatusBadGateway, []byte(`{"error":{"code":"upstream_connection_failed","message":"dial tcp: connection refused"}}`))
	if code != "upstream_connection_failed" || message != "dial tcp: connection refused" {
		t.Fatalf("runtime error = %s %q", code, message)
	}
}

func TestAdmissionUserErrorSeparatesBillingSubscriptionAndInternalFailures(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{err: store.ErrInsufficientBalance, status: http.StatusPaymentRequired, code: "insufficient_balance"},
		{err: store.ErrSubscriptionUnavailable, status: http.StatusServiceUnavailable, code: "subscription_unavailable"},
		{err: store.ErrSubscriptionExhausted, status: http.StatusPaymentRequired, code: "subscription_quota_exhausted"},
		{err: store.ErrSubscriptionRequired, status: http.StatusForbidden, code: "subscription_not_assigned"},
		{err: errors.New("database unavailable"), status: http.StatusInternalServerError, code: "admission_internal_error"},
	}
	for _, test := range tests {
		got := admissionUserError(test.err)
		if got.Status != test.status || got.Code != test.code {
			t.Fatalf("classification for %v = %+v", test.err, got)
		}
	}
}

func TestWriteErrorIncludesStableTypeRetryabilityAndHeader(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeError(recorder, http.StatusServiceUnavailable, "subscription_unavailable", "订阅不可用")
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("X-Relay-Error-Code") != "subscription_unavailable" {
		t.Fatalf("status/header = %d/%q", recorder.Code, recorder.Header().Get("X-Relay-Error-Code"))
	}
	var body struct {
		Error struct {
			Code    string         `json:"code"`
			Type    string         `json:"type"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "subscription_unavailable" || body.Error.Type != "server_error" || body.Error.Details["retryable"] != false {
		t.Fatalf("body = %+v", body)
	}
}
