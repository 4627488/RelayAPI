package app

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
)

type rollingCapture struct {
	buf      []byte
	detail   []byte
	max      int
	total    int64
	bufStart int
	bufFull  bool
}

func (c *rollingCapture) Write(p []byte) (int, error) {
	size := len(p)
	c.total += int64(size)
	if len(c.detail) < requestLogDetailLimit {
		remaining := requestLogDetailLimit - len(c.detail)
		if remaining > len(p) {
			remaining = len(p)
		}
		c.detail = append(c.detail, p[:remaining]...)
	}
	if c.max <= 0 || len(p) == 0 {
		return size, nil
	}
	if len(p) >= c.max {
		if cap(c.buf) < c.max {
			c.buf = make([]byte, c.max)
		} else {
			c.buf = c.buf[:c.max]
		}
		copy(c.buf, p[len(p)-c.max:])
		c.bufStart = 0
		c.bufFull = true
		return size, nil
	}
	if !c.bufFull {
		remaining := c.max - len(c.buf)
		if len(p) <= remaining {
			c.buf = append(c.buf, p...)
			c.bufFull = len(c.buf) == c.max
			return size, nil
		}
		c.buf = append(c.buf, p[:remaining]...)
		p = p[remaining:]
		c.bufFull = true
		c.bufStart = 0
	}
	first := min(len(p), c.max-c.bufStart)
	copy(c.buf[c.bufStart:], p[:first])
	copy(c.buf, p[first:])
	c.bufStart = (c.bufStart + len(p)) % c.max
	return size, nil
}
func (c *rollingCapture) Bytes() []byte {
	if !c.bufFull || c.bufStart == 0 {
		return c.buf
	}
	result := make([]byte, len(c.buf))
	at := copy(result, c.buf[c.bufStart:])
	copy(result[at:], c.buf[:c.bufStart])
	return result
}
func (c *rollingCapture) Info() ([]byte, bool, int64) {
	return append([]byte(nil), c.detail...), c.total > int64(len(c.detail)), c.total
}

// runtimeWriter tees the in-process runtime onto the client and a log capture.
// Status and body are forwarded as written; Relay does not rewrite them.
type runtimeWriter struct {
	client    http.ResponseWriter
	header    http.Header
	status    int
	stream    bool
	capture   *rollingCapture
	committed bool
	writeErr  error
	firstByte func()
}

func (w *runtimeWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *runtimeWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status == 0 {
		status = http.StatusOK
	}
	w.status = status
	w.commit()
}

func (w *runtimeWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.firstByte != nil {
		w.firstByte()
		w.firstByte = nil
	}
	if w.capture != nil {
		_, _ = w.capture.Write(payload)
	}
	written, err := w.client.Write(payload)
	if err != nil {
		w.writeErr = &streamCopyError{operation: "write_downstream", err: err}
	}
	return written, err
}

func (w *runtimeWriter) Flush() {
	if w.status == 0 {
		return
	}
	if flusher, ok := w.client.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *runtimeWriter) commit() {
	if w.committed || w.client == nil {
		return
	}
	copyHeaders(w.client.Header(), w.Header())
	if w.stream {
		setStreamingHeaders(w.client.Header(), true)
	}
	status := w.status
	if status == 0 {
		status = http.StatusOK
	}
	w.client.WriteHeader(status)
	if w.stream {
		if flusher, ok := w.client.(http.Flusher); ok {
			flusher.Flush()
		}
	}
	w.committed = true
}

func (w *runtimeWriter) statusCode() int {
	if w == nil || w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

type publicInference struct {
	key                    store.KeyContext
	requestID              string
	admission              store.Admission
	meta                   requestMeta
	body                   []byte
	originalBody           []byte
	started                time.Time
	timeline               *latencyTimeline
	billable               bool
	logContext             requestLogContext
	price                  store.ResolvedPrice
	priceConfigured        bool
	deferredAdmissionPrice <-chan priceLookupResult
	targetAdmission        *gateway.Client
}

func (a *App) serveInference(w http.ResponseWriter, r *http.Request, call publicInference) {
	prepareRuntimeHeaders(r.Header, call.requestID, call.admission.UpstreamCredentialID)
	if isCodexResponsesPath(r.URL.Path) {
		models := []string(nil)
		if a.nativeRuntime != nil {
			models = a.nativeRuntime.Models()
		}
		w.Header().Set("X-Models-Etag", modelCatalogRevision(call.key, models, a.codexCatalogRevisionToken()))
	}
	if call.admission.ChildSubscriptionID != "" {
		w.Header().Set("X-Relay-Subscription-ID", call.admission.ChildSubscriptionID)
	}
	call.timeline.Step(time.Now(), "prepare_runtime_request", "准备运行时请求", "relay", "去掉客户端凭据头并钉住上游账户")
	capture := &rollingCapture{max: 2 << 20}
	var firstByteAt time.Time
	out := &runtimeWriter{client: w, stream: call.meta.Stream, capture: capture, firstByte: func() {
		if firstByteAt.IsZero() {
			firstByteAt = time.Now()
		}
	}}
	a.nativeRuntime.Serve(out, r, call.body)
	status := out.statusCode()
	errorForDetail := ""
	if status >= http.StatusBadRequest {
		errorForDetail = "upstream_http_error"
	}
	a.maybeCaptureForwardedRequest(&call.logContext, r, call.originalBody, call.body, r.Header, call.requestID, status, errorForDetail)
	call.body = nil
	call.originalBody = nil
	call.targetAdmission.RecordOutcome(out.writeErr)
	writeErr := out.writeErr
	upstreamHeaders := out.Header().Clone()
	responseReadAt := time.Now()
	call.logContext.completedAt = responseReadAt
	finalizeCtx := context.WithoutCancel(r.Context())
	a.finalizeResponse(func() {
		price := call.price
		logContext := call.logContext
		if call.deferredAdmissionPrice != nil {
			lookup := <-call.deferredAdmissionPrice
			if lookup.err == nil {
				price = lookup.price
				logContext.price = &price
			}
		}
		parsed := billing.ParseResponse(capture.Bytes())
		if call.priceConfigured && parsed.ResponseServiceTier != "" {
			if resolved, resolveErr := a.store.ResolvePrice(finalizeCtx, requestPriceDimensions(call.key, call.meta, r.URL.Path, admissionAuthIndex(call.admission), parsed.ResponseServiceTier)); resolveErr == nil {
				price = resolved
				logContext.price = &price
				_ = a.store.UpdateReservationPriceSnapshot(finalizeCtx, call.requestID, store.EncodePriceSnapshot(price))
			}
		}
		actual := int64(0)
		settled := !call.billable
		var cost *int64
		if call.billable && status < http.StatusBadRequest && parsed.Found && call.priceConfigured && billing.UsageComplete(price, parsed.Usage) {
			actual = billing.Cost(price, parsed.Usage)
			cost = &actual
			if err := a.store.SettleRequestReservation(finalizeCtx, call.requestID, actual, true); err == nil {
				settled = true
			} else {
				slog.Error("settle request", "request_id", call.requestID, "error", err)
			}
		} else if call.billable && status < http.StatusBadRequest {
			// Missing usage must not become free parent capacity. Conservatively
			// settle the reservation and keep pricing_complete=false for reconciliation.
			actual = max64(call.admission.BalanceReservedNanoUSD, call.admission.QuotaReservedNanoUSD)
			if err := a.store.SettleRequestReservation(finalizeCtx, call.requestID, actual, false); err == nil {
				settled = true
			} else {
				slog.Error("settle incomplete request", "request_id", call.requestID, "error", err)
			}
		} else if call.billable {
			a.releaseReservation(call.requestID, true)
			settled = true
		}
		errorMessage := ""
		rawResponse, responseTruncated, responseBytes := capture.Info()
		if writeErr != nil {
			errorMessage = writeErr.Error()
			logContext.errorCode = "stream_copy_error"
		} else if status >= http.StatusBadRequest {
			logContext.errorCode, errorMessage = observedError(status, rawResponse)
		}
		logContext.upstreamTraceID = firstNonEmptyString(
			strings.TrimSpace(upstreamHeaders.Get("X-Upstream-TRACE-ID")),
			strings.TrimSpace(upstreamHeaders.Get("X-CPA-TRACE-ID")),
		)
		logContext.responseBytes = responseBytes
		if !firstByteAt.IsZero() {
			ttft := firstByteAt.Sub(call.started).Milliseconds()
			logContext.ttftMS = &ttft
			call.timeline.Mark(firstByteAt, "first_byte", "客户端首字节")
		}
		retainDetail := shouldRetainRequestDetail(call.requestID, status, logContext.errorCode, a.cfg.RequestSuccessSamplePPM)
		logContext.maybeCaptureUpstream(status, upstreamHeaders, rawResponse, responseTruncated, responseBytes, retainDetail)
		if retainDetail && (writeErr != nil || status >= http.StatusBadRequest) {
			detail := logContext.ensureDetail()
			detail.ErrorName = logContext.errorCode
			detail.ErrorMessage = errorMessage
		}
		// Settlement and durable logging now run after the response boundary and
		// must not inflate the latency reported to users.
		call.timeline.Mark(responseReadAt, "complete", "响应完成")
		a.addNativeRuntimeTrace(call.timeline, call.requestID)
		stageTimings := call.timeline.JSON(responseReadAt)
		if retainDetail {
			logContext.ensureDetail().StageTimings = stageTimings
		}
		logContext.stageTimings = stageTimings
		a.writeRequestLog(call.key, call.requestID, call.admission, call.meta, r, status, call.started, &parsed, cost != nil, settled, actual, errorMessage, logContext)
		a.store.TouchKey(finalizeCtx, call.key.ID)
	})
}

func isCodexResponsesPath(path string) bool {
	path = strings.TrimRight(strings.TrimSpace(path), "/")
	return path == "/v1/responses" || path == "/backend-api/codex/responses" || path == "/openai/v1/responses"
}

type streamCopyError struct {
	operation string
	err       error
}

func (e *streamCopyError) Error() string { return e.operation + ": " + e.err.Error() }
func (e *streamCopyError) Unwrap() error { return e.err }

func setStreamingHeaders(header http.Header, stream bool) {
	if !stream {
		return
	}
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("X-Accel-Buffering", "no")
}

func copyHeaders(destination, source http.Header) {
	for name, values := range source {
		if hopHeader(name) || strings.HasPrefix(strings.ToLower(name), "x-relay-") {
			continue
		}
		destination.Del(name)
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func stripRelayHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "x-relay-") {
			header.Del(name)
		}
	}
}

func prepareRuntimeHeaders(header http.Header, requestID, credentialID string) {
	stripRelayHeaders(header)
	header.Del("Authorization")
	header.Del("X-API-Key")
	header.Del("X-Goog-API-Key")
	if requestID != "" {
		header.Set("X-Relay-Request-ID", requestID)
	}
	if credentialID != "" {
		header.Set("X-Relay-Upstream-Credential-ID", credentialID)
		header.Set("X-Relay-CPA-Auth-ID", credentialID)
	}
}

func hopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
