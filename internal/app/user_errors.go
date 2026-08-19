package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

// userFacingError is the gateway's stable public error contract. Upstream
// status codes are diagnostic input; they are not automatically the status a
// Relay user should receive.
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
	details := map[string]any{"retryable": value.Retryable}
	if value.UpstreamStatus > 0 {
		details["upstream_status"] = value.UpstreamStatus
	}
	writeJSON(w, value.Status, map[string]any{"error": map[string]any{
		"code": value.Code, "type": errorTypeForStatus(value.Status),
		"message": value.Message, "details": details,
	}})
}

func admissionUserError(err error) userFacingError {
	switch {
	case err == nil:
		return userFacingError{}
	case errors.Is(err, store.ErrInsufficientBalance):
		return userFacingError{Status: http.StatusPaymentRequired, Code: "insufficient_balance", Message: "账户余额不足，请充值后重试"}
	case errors.Is(err, store.ErrSubscriptionPrice):
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "subscription_pricing_unavailable", Message: "该订阅的模型价格尚未配置，请联系管理员完善计费配置"}
	case errors.Is(err, store.ErrSubscriptionUnavailable):
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "subscription_unavailable", Message: "分配给你的订阅当前不可用，请联系管理员检查模型账户或订阅配置"}
	case errors.Is(err, store.ErrSubscriptionRequired):
		return userFacingError{Status: http.StatusForbidden, Code: "subscription_not_assigned", Message: "你尚未获得该模型对应订阅的使用权限"}
	case errors.Is(err, store.ErrSubscriptionExhausted):
		return userFacingError{Status: http.StatusPaymentRequired, Code: "subscription_quota_exhausted", Message: "分配给你的订阅额度已用尽，请等待额度重置或联系管理员"}
	default:
		return userFacingError{Status: http.StatusInternalServerError, Code: "admission_internal_error", Message: "请求准入检查失败，请稍后重试；若持续出现请联系管理员", Retryable: true}
	}
}

func (a *App) classifyUpstreamError(status int, payload []byte, admission store.Admission) userFacingError {
	code, upstreamType, message := upstreamErrorFields(payload)
	lower := strings.ToLower(strings.Join([]string{code, upstreamType, message, string(payload)}, " "))
	account := modelAccountSubject(admission)
	result := userFacingError{Status: status, Code: "upstream_request_failed", Message: message, UpstreamStatus: status}
	if result.Message == "" {
		switch status {
		case http.StatusBadRequest:
			result.Message = "模型服务无法处理该请求，请检查模型名和请求参数"
		case http.StatusForbidden:
			result.Message = "模型服务拒绝了当前请求"
		case http.StatusNotFound:
			result.Message = "模型服务未找到请求的接口或模型"
		default:
			result.Message = http.StatusText(status)
		}
	}

	if hasAny(lower, "auth_unavailable", "auth_not_found", "no auth available", "no available auth") {
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_unavailable", Message: account + "不可用，请联系管理员检查账户状态", Retryable: true, UpstreamStatus: status}
	}
	if hasAny(lower, "subscription expired", "subscription inactive", "subscription disabled", "account deactivated", "account suspended") {
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_subscription_invalid", Message: account + "已失效或被停用，请联系管理员更换或重新认证账户", UpstreamStatus: status}
	}
	if status == http.StatusUnauthorized || hasAny(lower,
		"authentication_error", "invalid_api_key", "invalid or expired token", "invalid token",
		"token expired", "refresh_token_reused", "refresh token expired") {
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_auth_failed", Message: account + "登录已失效，请联系管理员重新认证该账户", UpstreamStatus: status}
	}
	if status == http.StatusPaymentRequired || status == http.StatusTooManyRequests && hasAny(lower,
		"insufficient_quota", "quota_exceeded", "quota exceeded", "quota exhausted", "usage limit",
		"credit balance", "credits exhausted", "insufficient balance", "billing limit", "额度不足", "额度已用尽") {
		return userFacingError{Status: http.StatusPaymentRequired, Code: "model_account_quota_exhausted", Message: account + "额度已用尽，请等待额度重置或联系管理员", UpstreamStatus: status}
	}
	if status == http.StatusTooManyRequests && hasAny(lower, "rate_limit", "rate limit", "too many requests", "requests per minute") {
		return userFacingError{Status: http.StatusTooManyRequests, Code: "upstream_rate_limited", Message: "模型服务当前请求过多，请稍后重试", Retryable: true, UpstreamStatus: status}
	}
	if status == http.StatusForbidden && hasAny(lower, "model", "permission", "not allowed", "not authorized", "access denied") {
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_permission_denied", Message: account + "无权使用该模型，请联系管理员检查账户模型权限", UpstreamStatus: status}
	}
	if hasAny(lower, "model_not_found", "model_not_supported", "model does not exist", "model is not available", "unknown model") {
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_model_unavailable", Message: account + "未提供该模型，请联系管理员检查模型配置", UpstreamStatus: status}
	}
	if runtimeError := a.runtimeCredentialError(admission, status); runtimeError != nil {
		return *runtimeError
	}

	switch {
	case status == http.StatusTooManyRequests:
		return userFacingError{Status: http.StatusTooManyRequests, Code: "upstream_rate_limited", Message: "模型服务当前请求过多，请稍后重试", Retryable: true, UpstreamStatus: status}
	case status == http.StatusNotFound && hasAny(lower, "model", "deployment"):
		return userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_model_unavailable", Message: account + "未提供该模型，请联系管理员检查模型配置", UpstreamStatus: status}
	case status == http.StatusNotFound:
		return userFacingError{Status: http.StatusBadGateway, Code: "upstream_endpoint_not_found", Message: "模型服务接口地址配置有误，请联系管理员检查账户接口地址", UpstreamStatus: status}
	case status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout:
		return userFacingError{Status: http.StatusGatewayTimeout, Code: "upstream_timeout", Message: "模型服务响应超时，请稍后重试", Retryable: true, UpstreamStatus: status}
	case status >= http.StatusInternalServerError:
		return userFacingError{Status: http.StatusBadGateway, Code: "upstream_service_error", Message: "模型服务暂时异常，请稍后重试", Retryable: true, UpstreamStatus: status}
	case status == http.StatusBadRequest && hasAny(lower, "context_length", "context length", "maximum context", "too many tokens"):
		return userFacingError{Status: http.StatusBadRequest, Code: "context_length_exceeded", Message: "请求内容超过该模型的上下文长度，请缩短输入后重试", UpstreamStatus: status}
	case status == http.StatusBadRequest:
		result.Code = firstNonEmptyString(code, "invalid_request")
	case status == http.StatusForbidden:
		result.Code = "upstream_request_forbidden"
	default:
		result.Code = firstNonEmptyString(code, "upstream_request_failed")
	}
	return result
}

func (a *App) runtimeCredentialError(admission store.Admission, upstreamStatus int) *userFacingError {
	if a == nil || a.nativeRuntime == nil || strings.TrimSpace(admission.UpstreamCredentialID) == "" {
		return nil
	}
	status, ok := a.nativeRuntime.CredentialStatus(admission.UpstreamCredentialID)
	if !ok {
		value := userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_unavailable", Message: "当前订阅绑定的模型账户已不存在，请联系管理员重新配置", Retryable: true, UpstreamStatus: upstreamStatus}
		return &value
	}
	if status.QuotaExceeded {
		value := userFacingError{Status: http.StatusPaymentRequired, Code: "model_account_quota_exhausted", Message: modelAccountSubject(admission) + "额度已用尽，请等待额度重置或联系管理员", UpstreamStatus: upstreamStatus}
		return &value
	}
	if status.Unavailable {
		value := userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_unavailable", Message: modelAccountSubject(admission) + "暂时不可用，请联系管理员检查账户状态", Retryable: true, UpstreamStatus: upstreamStatus}
		return &value
	}
	return nil
}

func modelAccountSubject(admission store.Admission) string {
	if strings.TrimSpace(admission.ParentSubscriptionID) != "" {
		return "当前订阅的模型账户"
	}
	return "当前模型账户"
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

func hasAny(value string, fragments ...string) bool {
	for _, fragment := range fragments {
		if strings.Contains(value, fragment) {
			return true
		}
	}
	return false
}
