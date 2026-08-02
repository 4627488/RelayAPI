package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"

	"github.com/4627488/RelayAPI/internal/store"
)

const requestLogDetailLimit = 128 << 10

type cpaTransportError struct {
	Status    int
	Code      string
	Message   string
	Phase     string
	Retryable bool
}

var sensitiveLogHeaders = map[string]struct{}{
	"api-key": {}, "authorization": {}, "cookie": {}, "set-cookie": {},
	"x-api-key": {}, "openai-api-key": {}, "proxy-authorization": {},
	"x-relay-plugin-secret": {}, "x-relay-plugin-signature": {},
}

func sanitizedHeaders(header http.Header) string {
	values := make(http.Header, len(header))
	for name, entries := range header {
		if _, sensitive := sensitiveLogHeaders[strings.ToLower(name)]; sensitive {
			values[name] = []string{"[REDACTED]"}
			continue
		}
		values[name] = append([]string(nil), entries...)
	}
	raw, _ := json.Marshal(values)
	return string(raw)
}

func boundedDetail(payload []byte) (text string, truncated bool, originalBytes int64) {
	originalBytes = int64(len(payload))
	if len(payload) <= requestLogDetailLimit {
		return string(payload), false, originalBytes
	}
	return string(payload[:requestLogDetailLimit]), true, originalBytes
}

func sampledRequest(requestID string, ppm int) bool {
	if ppm <= 0 {
		return false
	}
	if ppm >= 1_000_000 {
		return true
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(requestID))
	return int(hash.Sum64()%1_000_000) < ppm
}

func requestType(path string) string {
	switch {
	case strings.Contains(path, "/responses"):
		return "responses"
	case strings.Contains(path, "/chat/completions"):
		return "chat.completions"
	case strings.Contains(path, "/messages"):
		return "messages"
	case strings.Contains(path, ":streamGenerateContent"):
		return "gemini.streamGenerateContent"
	case strings.Contains(path, ":generateContent"):
		return "gemini.generateContent"
	case strings.Contains(path, "/embeddings"):
		return "embeddings"
	case strings.Contains(path, "/images"):
		return "images"
	default:
		return strings.Trim(strings.TrimSpace(path), "/")
	}
}

func baseRequestDetail(r *http.Request, body []byte) *store.LogDetailInput {
	text, truncated, size := boundedDetail(body)
	return &store.LogDetailInput{
		RequestHeaders: sanitizedHeaders(r.Header), RequestBody: text,
		RequestBodyTruncated: truncated, RequestBodyBytes: size, StageTimings: "{}",
	}
}

func timingJSON(values map[string]int64) string {
	raw, _ := json.Marshal(values)
	return string(raw)
}

func upstreamErrorMessage(status int, payload []byte) string {
	var value map[string]any
	if json.Unmarshal(payload, &value) == nil {
		if nested, ok := value["error"].(map[string]any); ok {
			if message, ok := nested["message"].(string); ok && strings.TrimSpace(message) != "" {
				return boundedErrorText(message)
			}
		}
		if message, ok := value["message"].(string); ok && strings.TrimSpace(message) != "" {
			return boundedErrorText(message)
		}
		if message, ok := value["error"].(string); ok && strings.TrimSpace(message) != "" {
			return boundedErrorText(message)
		}
	}
	if text := strings.TrimSpace(http.StatusText(status)); text != "" {
		return text
	}
	return "upstream request failed"
}

func boundedErrorText(value string) string {
	const limit = 2048
	value = strings.TrimSpace(value)
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

func classifyCPATransportError(err error, requestContextError error, phase string) cpaTransportError {
	result := cpaTransportError{Status: http.StatusServiceUnavailable, Code: "cpa_unavailable", Message: "CPA 暂时不可用，请稍后重试", Phase: phase, Retryable: true}
	if err == nil {
		return result
	}
	if errors.Is(requestContextError, context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		result.Status = http.StatusGatewayTimeout
		result.Code = "cpa_timeout"
		result.Message = "CPA 响应超时，请稍后重试"
		return result
	}
	if errors.Is(requestContextError, context.Canceled) || errors.Is(err, context.Canceled) {
		result.Status = 499
		result.Code = "client_canceled"
		result.Message = "请求已由客户端取消"
		result.Retryable = false
		return result
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		result.Status = http.StatusGatewayTimeout
		result.Code = "cpa_timeout"
		result.Message = "CPA 响应超时，请稍后重试"
		return result
	}
	lower := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, io.EOF), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE),
		strings.Contains(lower, "unexpected eof"), strings.Contains(lower, "connection reset"),
		strings.Contains(lower, "server closed idle connection"):
		result.Code = "cpa_connection_lost"
		result.Message = "与 CPA 的连接提前中断；CPA 可能刚刚重启或触发了内存保护，请重试"
	case errors.Is(err, syscall.ECONNREFUSED), strings.Contains(lower, "connection refused"), strings.Contains(lower, "no such host"):
		result.Code = "cpa_unavailable"
		result.Message = "无法连接 CPA 服务；服务可能正在启动或恢复，请稍后重试"
	}
	return result
}

func writeCPATransportError(w http.ResponseWriter, r *http.Request, err error, phase, requestID string) cpaTransportError {
	var requestErr error
	if r != nil {
		requestErr = r.Context().Err()
	}
	classified := classifyCPATransportError(err, requestErr, phase)
	details := map[string]any{"phase": classified.Phase, "retryable": classified.Retryable}
	if requestID != "" {
		details["request_id"] = requestID
	}
	if classified.Retryable {
		details["retry_after_seconds"] = 5
		w.Header().Set("Retry-After", "5")
	}
	w.Header().Set("X-Relay-Error-Code", classified.Code)
	writeJSON(w, classified.Status, map[string]any{"error": map[string]any{
		"code": classified.Code, "type": "service_unavailable", "message": classified.Message, "details": details,
	}})
	return classified
}

func detailedUpstreamError(payload []byte, provider, model, requestID string, assignedCredential bool) ([]byte, string, bool) {
	var value struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return payload, "", false
	}
	original := strings.TrimSpace(value.Error.Message)
	if value.Error.Code != "auth_unavailable" && !strings.Contains(strings.ToLower(original), "auth_unavailable") {
		return payload, "", false
	}
	if provider == "" {
		provider = errorAttribute(original, "providers")
	}
	if model == "" {
		model = errorAttribute(original, "model")
	}
	scope := "provider_pool"
	subject := "the provider authentication pool"
	action := "check the provider accounts and add a backup credential"
	if assignedCredential {
		scope = "assigned_credential"
		subject = "the credential assigned to this subscription"
		action = "check that model account's status and quota, or assign a backup credential"
	}
	message := fmt.Sprintf("Authentication is temporarily unavailable for model %s: %s is not currently eligible. Common causes are cooldown after an upstream failure, rate limiting, exhausted quota, or disabled/expired authentication. Retry in 5 seconds; if this persists, %s.", model, subject, action)
	result, err := json.Marshal(map[string]any{"error": map[string]any{
		"code": "auth_unavailable", "type": "service_unavailable", "message": message,
		"details": map[string]any{
			"provider": provider, "model": model, "scope": scope, "reason": "no_eligible_credentials",
			"retryable": true, "retry_after_seconds": 5, "request_id": requestID, "upstream_message": original,
		},
	}})
	if err != nil {
		return payload, "", false
	}
	return result, "auth_unavailable", true
}

func errorAttribute(message, name string) string {
	marker := name + "="
	start := strings.Index(message, marker)
	if start < 0 {
		return ""
	}
	value := message[start+len(marker):]
	if end := strings.IndexAny(value, ",)"); end >= 0 {
		value = value[:end]
	}
	return strings.TrimSpace(value)
}
