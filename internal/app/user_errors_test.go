package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestClassifyUpstreamErrorReportsCauseInsteadOfBlindStatus(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		want     int
		wantCode string
	}{
		{name: "CPA scheduler has no account", status: http.StatusTooManyRequests, body: `{"error":{"code":"auth_unavailable","message":"no auth available"}}`, want: http.StatusServiceUnavailable, wantCode: "model_account_unavailable"},
		{name: "account quota exhausted", status: http.StatusTooManyRequests, body: `{"error":{"code":"insufficient_quota","message":"usage limit reached"}}`, want: http.StatusPaymentRequired, wantCode: "model_account_quota_exhausted"},
		{name: "real upstream rate limit", status: http.StatusTooManyRequests, body: `{"error":{"code":"rate_limit_exceeded","message":"too many requests"}}`, want: http.StatusTooManyRequests, wantCode: "upstream_rate_limited"},
		{name: "expired account login", status: http.StatusUnauthorized, body: `{"error":{"message":"token expired"}}`, want: http.StatusServiceUnavailable, wantCode: "model_account_auth_failed"},
		{name: "account lacks model permission", status: http.StatusForbidden, body: `{"error":{"message":"model not allowed for this account"}}`, want: http.StatusServiceUnavailable, wantCode: "model_account_permission_denied"},
		{name: "provider outage", status: http.StatusInternalServerError, body: `{"error":{"message":"internal"}}`, want: http.StatusBadGateway, wantCode: "upstream_service_error"},
		{name: "context too large", status: http.StatusBadRequest, body: `{"error":{"message":"maximum context length exceeded"}}`, want: http.StatusBadRequest, wantCode: "context_length_exceeded"},
	}
	app := &App{}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := app.classifyUpstreamError(test.status, []byte(test.body), store.Admission{})
			if got.Status != test.want || got.Code != test.wantCode || got.UpstreamStatus != test.status {
				t.Fatalf("classification = %+v, want status/code %d/%s", got, test.want, test.wantCode)
			}
		})
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
