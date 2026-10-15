package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

// userFacingError is Relay's own public error contract (auth, admission,
// policy).
type userFacingError struct {
	Status         int
	Code           string
	Message        string
	Retryable      bool
	UpstreamStatus int
}

func errorTypeForStatus(status int) string {
	switch {
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusForbidden:
		return "permission_error"
	case status == http.StatusPaymentRequired:
		return "insufficient_funds_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status >= http.StatusInternalServerError:
		return "server_error"
	default:
		return "invalid_request_error"
	}
}

func defaultErrorRetryable(status int, code string) bool {
	switch code {
	case "model_account_auth_failed", "model_account_subscription_invalid", "model_account_permission_denied", "model_account_model_unavailable",
		"subscription_unavailable", "subscription_pricing_unavailable", "pricing_unavailable", "insufficient_balance",
		"subscription_quota_exhausted", "model_account_quota_exhausted", "subscription_not_assigned", "model_not_allowed":
		return false
	default:
		return status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
	}
}

func writeUserFacingError(w http.ResponseWriter, value userFacingError) {
	if value.Status == 0 {
		value.Status = http.StatusInternalServerError
	}
	w.Header().Set("X-Relay-Error-Code", value.Code)
	w.Header().Set("X-Relay-Error-Source", "relay")
	details := map[string]any{"retryable": value.Retryable}
	if value.UpstreamStatus > 0 {
		details["upstream_status"] = value.UpstreamStatus
	}
	writeJSON(w, value.Status, map[string]any{"error": map[string]any{
		"code": value.Code, "type": errorTypeForStatus(value.Status),
		"message": value.Message, "details": details, "source": "relay",
	}})
}

func admissionUserError(err error) userFacingError {
	switch {
	case err == nil:
		return userFacingError{}
	case errors.Is(err, store.ErrInsufficientBalance):
		return userFacingError{Status: http.StatusPaymentRequired, Code: "insufficient_balance", Message: "Your account balance is insufficient. Add funds and try again."}
	case errors.Is(err, store.ErrSubscriptionPrice):
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "subscription_pricing_unavailable", Message: "Pricing is not configured for this subscription. Contact your administrator."}
	case errors.Is(err, store.ErrSubscriptionUnavailable):
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "subscription_unavailable", Message: "Your assigned subscription is unavailable. Contact your administrator to check the model account and subscription settings."}
	case errors.Is(err, store.ErrSubscriptionRequired):
		return userFacingError{Status: http.StatusForbidden, Code: "subscription_not_assigned", Message: "You do not have a subscription for this model. Contact your administrator to request access."}
	case errors.Is(err, store.ErrSubscriptionExhausted):
		return userFacingError{Status: http.StatusPaymentRequired, Code: "subscription_quota_exhausted", Message: "Your subscription quota is exhausted. Wait for it to reset or contact your administrator."}
	default:
		return userFacingError{Status: http.StatusInternalServerError, Code: "admission_internal_error", Message: "Relay could not check whether this request is allowed. Try again later. If the problem persists, contact your administrator.", Retryable: true}
	}
}

func observedError(status int, payload []byte) (code, message string) {
	code, _, message = upstreamErrorFields(payload)
	if message == "" {
		message = upstreamErrorMessage(status, payload)
	}
	if code == "" {
		code = "upstream_http_error"
	}
	return code, message
}

func upstreamErrorFields(payload []byte) (code, errorType, message string) {
	var root map[string]any
	if json.Unmarshal(payload, &root) != nil {
		text := boundedErrorText(string(payload))
		if strings.HasPrefix(strings.TrimSpace(text), "<") {
			text = ""
		}
		return "", "", text
	}
	value := root
	if nested, ok := root["error"].(map[string]any); ok {
		value = nested
	}
	code, _ = value["code"].(string)
	errorType, _ = value["type"].(string)
	message, _ = value["message"].(string)
	if message == "" {
		message, _ = root["message"].(string)
	}
	if message == "" {
		if text, ok := root["error"].(string); ok {
			message = text
		}
	}
	return strings.TrimSpace(code), strings.TrimSpace(errorType), boundedErrorText(message)
}
