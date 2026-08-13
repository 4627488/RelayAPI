package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/store"
)

// Raw bodies are diagnostic data, not accounting data. Keep the error detail
// ceiling small enough that a burst of bad requests cannot become a storage
// incident; request_logs still retains the complete structured summary.
const requestLogDetailLimit = 32 << 10

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
	"x-goog-api-key":        {},
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
	limit := len(payload)
	if limit <= requestLogDetailLimit {
		if !utf8.Valid(payload) {
			return strings.ToValidUTF8(string(payload), "\uFFFD"), false, originalBytes
		}
		return string(payload), false, originalBytes
	}
	limit = requestLogDetailLimit
	// A byte limit can split a multi-byte rune. PostgreSQL text columns reject
	// the resulting invalid UTF-8, so back up to the last complete rune. Also
	// replace any invalid bytes already present in the retained payload.
	for limit > 0 && !utf8.RuneStart(payload[limit]) {
		limit--
	}
	return strings.ToValidUTF8(string(payload[:limit]), "\uFFFD"), true, originalBytes
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

func shouldRetainRequestDetail(requestID string, status int, errorCode string, successSamplePPM int) bool {
	if status <= 0 || status >= http.StatusBadRequest || strings.TrimSpace(errorCode) != "" {
		return true
	}
	return sampledRequest(requestID, successSamplePPM)
}

func requestType(path string, websocket bool) string {
	if websocket {
		if strings.Contains(path, "/responses") {
			return "responses.websocket"
		}
		return "websocket"
	}
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

func captureWebSocketRequest(detail *store.LogDetailInput, payload []byte) {
	if detail == nil {
		return
	}
	detail.RequestBody, detail.RequestBodyTruncated, detail.RequestBodyBytes = boundedDetail(payload)
}

func baseRequestDetail(r *http.Request, body []byte) *store.LogDetailInput {
	text, truncated, size := boundedDetail(body)
	return &store.LogDetailInput{
		RequestHeaders: sanitizedHeaders(r.Header), RequestBody: text,
		RequestBodyTruncated: truncated, RequestBodyBytes: size, StageTimings: "{}",
	}
}

func captureForwardedRequest(detail *store.LogDetailInput, original, forwarded []byte) {
	if detail == nil {
		return
	}
	detail.ForwardedBodyBytes = int64(len(forwarded))
	if bytes.Equal(original, forwarded) {
		// The client body is already stored. Retaining an identical second copy
		// adds no diagnostic information.
		return
	}
	detail.ForwardedBody, detail.ForwardedBodyTruncated, _ = boundedDetail(forwarded)
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
	value = strings.ToValidUTF8(strings.TrimSpace(value), "\uFFFD")
	if len(value) > limit {
		end := limit
		for end > 0 && !utf8.RuneStart(value[end]) {
			end--
		}
		return value[:end]
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
