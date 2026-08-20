package app

import (
	"bytes"
	"context"
	"encoding/json"
	"hash/fnv"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/store"
)

// Raw bodies are diagnostic data, not accounting data. Keep the error detail
// ceiling small enough that a burst of bad requests cannot become a storage
// incident; request_logs still retains the complete structured summary.
const requestLogDetailLimit = 32 << 10

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

func requestTransport(requestType string, stream bool) string {
	if strings.Contains(requestType, "websocket") {
		return "websocket"
	}
	if stream {
		return "sse"
	}
	return "http"
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

type requestLogContext struct {
	price           *store.ResolvedPrice
	detail          *store.LogDetailInput
	ttftMS          *int64
	upstreamTraceID string
	errorCode       string
	requestBytes    int64
	forwardedBytes  int64
	responseBytes   int64
	stageTimings    string
	completedAt     time.Time
}

func rejectedRequestDetail(r *http.Request, body []byte, code, message string, started time.Time, timeline ...*latencyTimeline) *store.LogDetailInput {
	detail := baseRequestDetail(r, body)
	if r.ContentLength > detail.RequestBodyBytes {
		detail.RequestBodyBytes = r.ContentLength
		detail.RequestBodyTruncated = true
	}
	detail.ErrorName = code
	detail.ErrorMessage = boundedErrorText(message)
	completed := time.Now()
	if len(timeline) > 0 && timeline[0] != nil {
		timeline[0].Step(completed, "relay_rejection", "Relay 返回错误", "relay", "请求在进入上游前被 Relay 拒绝")
		detail.StageTimings = timeline[0].JSON(completed)
	} else {
		fallback := newLatencyTimeline(started)
		fallback.Step(completed, "relay_rejection", "Relay 返回错误", "relay", "请求在进入上游前被 Relay 拒绝")
		detail.StageTimings = fallback.JSON(completed)
	}
	return detail
}

func (a *App) writeRejectedRequestLog(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta,
	r *http.Request, status int, started time.Time, code, message string, detail *store.LogDetailInput) {
	requestBytes := int64(0)
	stageTimings := "{}"
	if detail != nil {
		requestBytes = detail.RequestBodyBytes
		stageTimings = detail.StageTimings
	}
	a.writeRequestLog(key, requestID, admission, meta, r, status, started, nil, false, true, 0,
		boundedErrorText(message), requestLogContext{detail: detail, errorCode: code, requestBytes: requestBytes, stageTimings: stageTimings})
}

func (a *App) writeRequestLog(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, r *http.Request, status int,
	started time.Time, parsed *billing.Result, pricingComplete, settled bool, cost int64, errorMessage string, logContext requestLogContext) {
	input := requestLogInput(key, requestID, admission, meta, r, status, started, parsed, pricingComplete, settled, cost, errorMessage, logContext)
	if !shouldRetainRequestDetail(requestID, status, logContext.errorCode, a.cfg.RequestSuccessSamplePPM) {
		input.Detail = nil
	}
	if err := a.store.WriteLog(context.WithoutCancel(r.Context()), input); err != nil {
		slog.Error("write request log", "request_id", requestID, "error", err)
	}
}

func (a *App) finalizeResponse(task func()) {
	if task == nil {
		return
	}
	if a.finalizationSlots == nil {
		task()
		return
	}
	select {
	case a.finalizationSlots <- struct{}{}:
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			defer func() {
				<-a.finalizationSlots
				if value := recover(); value != nil {
					slog.Error("finalize response panic", "value", value)
				}
			}()
			task()
		}()
	default:
		// A saturated finalizer means the database is already behind. Preserve
		// accounting correctness and apply backpressure instead of creating an
		// unbounded goroutine queue.
		task()
	}
}

func requestLogInput(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, r *http.Request, status int,
	started time.Time, parsed *billing.Result, pricingComplete, settled bool, cost int64, errorMessage string, logContext requestLogContext) store.LogInput {
	client := identifyClientUserAgent(r.UserAgent())
	usage := store.Usage{}
	upstreamID := ""
	if parsed != nil {
		usage = parsed.Usage
		upstreamID = parsed.RequestID
	}
	var costPointer *int64
	if pricingComplete {
		costPointer = &cost
	}
	detail := logContext.detail
	if detail != nil {
		if logContext.requestBytes == 0 {
			logContext.requestBytes = detail.RequestBodyBytes
		}
		if logContext.forwardedBytes == 0 {
			logContext.forwardedBytes = detail.ForwardedBodyBytes
		}
		if logContext.responseBytes == 0 {
			logContext.responseBytes = detail.UpstreamBodyBytes
		}
	}
	completedAt := logContext.completedAt
	if completedAt.IsZero() {
		completedAt = time.Now()
	}
	return store.LogInput{
		ID: requestID, TenantID: key.TenantID, APIKeyID: key.ID, UpstreamRequestID: upstreamID, Model: meta.Model,
		UpstreamTraceID: logContext.upstreamTraceID, RequestedModel: meta.RequestedModel, ActualModel: meta.Model, ModelAlias: meta.ModelAlias, TenantName: key.TenantName,
		APIKeyName: key.Name, APIKeyPrefix: key.Prefix, RequestType: requestType(r.URL.Path, isWebSocketUpgrade(r)),
		ServiceTier: meta.ServiceTier, ResponseServiceTier: parsedResponseServiceTier(parsed), ReasoningEffort: meta.ReasoningEffort,
		ClientName: client.Name, ClientVersion: client.Version, UserAgent: client.UserAgent,
		AuthIndex: admissionAuthIndex(admission), ParentSubscriptionID: admission.ParentSubscriptionID,
		ChildSubscriptionID: admission.ChildSubscriptionID,
		Method:              r.Method, Path: r.URL.Path, StatusCode: status, Stream: meta.Stream, Usage: usage,
		CostNanoUSD: costPointer, Price: logContext.price, PricingComplete: pricingComplete, Settled: settled,
		ReservedNanoUSD: max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD), LatencyMS: completedAt.Sub(started).Milliseconds(),
		RequestBodyBytes: logContext.requestBytes, ForwardedBodyBytes: logContext.forwardedBytes, ResponseBodyBytes: logContext.responseBytes,
		TTFTMS: logContext.ttftMS, ErrorCode: logContext.errorCode, ErrorMessage: errorMessage,
		StageTimings: logContext.stageTimings,
		StartedAt:    started, CompletedAt: completedAt, Detail: detail,
	}
}

func parsedResponseServiceTier(parsed *billing.Result) string {
	if parsed == nil {
		return ""
	}
	return parsed.ResponseServiceTier
}
