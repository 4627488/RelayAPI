package app

import (
	"bytes"
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
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/store"
)

type upstreamErrorInfo struct {
	Code    string
	Type    string
	Message string
	Summary string
}

// Raw bodies are diagnostic data, not accounting data. Keep the error detail
// ceiling small enough that a burst of bad requests cannot become a storage
// incident; request_logs still retains the complete structured summary.
const requestLogDetailLimit = 32 << 10

type upstreamTransportError struct {
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
	case strings.Contains(path, "/embeddings"):
		return "embeddings"
	case strings.Contains(path, "/images"):
		return "images"
	default:
		return strings.Trim(strings.TrimSpace(path), "/")
	}
}

func (c *requestLogContext) ensureDetail() *store.LogDetailInput {
	if c.detail == nil {
		c.detail = &store.LogDetailInput{StageTimings: "{}"}
	}
	return c.detail
}

func (a *App) maybeCaptureForwardedRequest(logContext *requestLogContext, r *http.Request, original, forwarded []byte, upstreamHeader http.Header, requestID string, status int, errorCode string) {
	if forwarded != nil {
		logContext.forwardedBytes = int64(len(forwarded))
	}
	if !shouldRetainRequestDetail(requestID, status, errorCode, a.cfg.RequestSuccessSamplePPM) {
		return
	}
	detail := logContext.ensureDetail()
	if detail.RequestHeaders == "" {
		base := baseRequestDetail(r, original)
		detail.RequestHeaders = base.RequestHeaders
		detail.RequestBody = base.RequestBody
		detail.RequestBodyTruncated = base.RequestBodyTruncated
		if detail.RequestBodyBytes == 0 {
			detail.RequestBodyBytes = base.RequestBodyBytes
		}
		if detail.StageTimings == "" {
			detail.StageTimings = base.StageTimings
		}
	}
	if len(upstreamHeader) > 0 {
		detail.ForwardedHeaders = sanitizedHeaders(upstreamHeader)
	}
	captureForwardedRequest(detail, original, forwarded)
}

func (c *requestLogContext) maybeCaptureUpstream(status int, header http.Header, raw []byte, truncated bool, bytes int64, retain bool) {
	c.responseBytes = bytes
	if !retain {
		return
	}
	detail := c.ensureDetail()
	detail.UpstreamStatus = status
	detail.UpstreamHeaders = sanitizedHeaders(header)
	detail.UpstreamBody, _, _ = boundedDetail(raw)
	detail.UpstreamBodyTruncated = truncated || bytes > requestLogDetailLimit
	detail.UpstreamBodyBytes = bytes
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

func describeUpstreamError(status int, payload []byte) upstreamErrorInfo {
	code, errorType, message := upstreamErrorFields(payload)
	if message == "" {
		message = upstreamErrorMessage(status, payload)
	}
	descriptor := code
	if errorType != "" && !strings.EqualFold(errorType, code) {
		descriptor = strings.TrimSpace(descriptor + "/" + errorType)
	}
	prefix := fmt.Sprintf("upstream HTTP %d", status)
	if descriptor != "" {
		prefix += " " + descriptor
	}
	summary := prefix
	if message != "" {
		summary += ": " + message
	}
	return upstreamErrorInfo{Code: code, Type: errorType, Message: message, Summary: boundedErrorText(summary)}
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

func classifyUpstreamTransportError(err error, requestContextError error, phase string) upstreamTransportError {
	result := upstreamTransportError{Status: http.StatusServiceUnavailable, Code: "upstream_unavailable", Message: "上游运行时暂时不可用，请稍后重试", Phase: phase, Retryable: true}
	if err == nil {
		return result
	}
	if errors.Is(requestContextError, context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		result.Status = http.StatusGatewayTimeout
		result.Code = "upstream_timeout"
		result.Message = "上游响应超时，请稍后重试"
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
		result.Code = "upstream_timeout"
		result.Message = "上游响应超时，请稍后重试"
		return result
	}
	lower := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, io.EOF), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE),
		strings.Contains(lower, "unexpected eof"), strings.Contains(lower, "connection reset"),
		strings.Contains(lower, "server closed idle connection"):
		result.Code = "upstream_connection_lost"
		result.Message = "与 Upstream 的连接提前中断；Upstream 可能刚刚重启或触发了内存保护，请重试"
	case errors.Is(err, syscall.ECONNREFUSED), strings.Contains(lower, "connection refused"), strings.Contains(lower, "no such host"):
		result.Code = "upstream_unavailable"
		result.Message = "无法连接 上游运行时；服务可能正在启动或恢复，请稍后重试"
	}
	return result
}

func writeUpstreamTransportError(w http.ResponseWriter, r *http.Request, err error, phase, requestID string) upstreamTransportError {
	var requestErr error
	if r != nil {
		requestErr = r.Context().Err()
	}
	classified := classifyUpstreamTransportError(err, requestErr, phase)
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
