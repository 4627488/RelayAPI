package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode"

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
		{err: store.ErrSubscriptionExhausted, status: http.StatusTooManyRequests, code: "subscription_quota_exhausted"},
		{err: store.ErrSubscriptionRequired, status: http.StatusForbidden, code: "subscription_not_assigned"},
		{err: errors.New("database unavailable"), status: http.StatusInternalServerError, code: "admission_internal_error"},
	}
	for _, test := range tests {
		got := admissionUserError(test.err)
		if got.Status != test.status || got.Code != test.code {
			t.Fatalf("classification for %v = %+v", test.err, got)
		}
		for _, char := range got.Message {
			if unicode.Is(unicode.Han, char) {
				t.Fatalf("expected an English error message: %q", got.Message)
			}
		}
	}
}

func TestWriteErrorIncludesStableTypeRetryabilityAndHeader(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeError(recorder, http.StatusServiceUnavailable, "subscription_unavailable", "Your subscription is unavailable. Contact your administrator.")
	if recorder.Header().Get("X-Relay-Error-Source") != "relay" {
		t.Fatalf("error source = %q", recorder.Header().Get("X-Relay-Error-Source"))
	}
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

func TestResponsesErrorsSeparateMoneyFromSubscriptionQuota(t *testing.T) {
	for _, tc := range []struct {
		err      error
		status   int
		typeName string
	}{
		{store.ErrInsufficientBalance, http.StatusPaymentRequired, "insufficient_funds_error"},
		{store.ErrSubscriptionExhausted, http.StatusTooManyRequests, "rate_limit_error"},
	} {
		w := httptest.NewRecorder()
		writeUserFacingError(w, admissionUserError(tc.err))
		var doc map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		if w.Code != tc.status || w.Header().Get("X-Should-Retry") != "false" || doc["error"].(map[string]any)["type"] != tc.typeName || doc["type"] != nil {
			t.Fatalf("wrong Responses error contract: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestLimitErrorsAdvertiseKnownResetWithoutImmediateQuotaRetry(t *testing.T) {
	reset := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		code  string
		wait  int64
		retry bool
	}{
		{"api_key_rate_limit_exceeded", 48, true},
		{"tenant_daily_token_limit_exceeded", 43200, false},
		{"api_key_daily_token_limit_exceeded", 43200, false},
	} {
		value := publicError(http.StatusTooManyRequests, tc.code, "Limit reached; wait for its reset.")
		value.ResetsAt, value.RetryAfterSeconds = reset, tc.wait
		w := httptest.NewRecorder()
		writeUserFacingError(w, value)
		var doc struct {
			Error struct {
				Details struct {
					Retryable         bool      `json:"retryable"`
					RetryAfterSeconds int64     `json:"retry_after_seconds"`
					ResetsAt          time.Time `json:"resets_at"`
				} `json:"details"`
			} `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		if w.Header().Get("Retry-After") != strconv.FormatInt(tc.wait, 10) || doc.Error.Details.Retryable != tc.retry || doc.Error.Details.RetryAfterSeconds != tc.wait || !doc.Error.Details.ResetsAt.Equal(reset) {
			t.Fatalf("%s: incorrect retry/reset contract: %s", tc.code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	writeUserFacingError(w, admissionUserError(store.ErrSubscriptionExhausted))
	if w.Header().Get("Retry-After") != "" || strings.Contains(w.Body.String(), "resets_at") || strings.Contains(w.Body.String(), "retry_after_seconds") || w.Header().Get("X-Should-Retry") != "false" {
		t.Fatalf("unknown subscription reset was invented: %s", w.Body.String())
	}
}
