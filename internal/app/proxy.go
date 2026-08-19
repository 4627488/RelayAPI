package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/tidwall/gjson"
)

type requestMeta struct {
	Model           string `json:"model"`
	Stream          bool   `json:"stream"`
	ServiceTier     string `json:"service_tier"`
	ReasoningEffort string `json:"reasoning_effort"`
	ImageCount      int    `json:"n"`
	RequestedModel  string `json:"-"`
	ModelAlias      string `json:"-"`
}

func readRequestMeta(body []byte, _ string) requestMeta {
	values := gjson.GetManyBytes(body, "model", "stream", "service_tier", "reasoning_effort", "reasoning.effort", "n")
	meta := requestMeta{
		Model:           strings.TrimSpace(values[0].String()),
		Stream:          values[1].Bool(),
		ServiceTier:     strings.TrimSpace(values[2].String()),
		ReasoningEffort: strings.TrimSpace(values[3].String()),
		ImageCount:      int(values[5].Int()),
	}
	if meta.ReasoningEffort == "" {
		meta.ReasoningEffort = strings.TrimSpace(values[4].String())
	}
	return meta
}

func requestMetadata(body []byte, r *http.Request) requestMeta {
	meta := readRequestMeta(body, r.URL.Path)
	if meta.Model == "" {
		meta = readFormRequestMeta(body, r.Header.Get("Content-Type"), meta)
	}
	if meta.Model == "" {
		meta.Model = strings.TrimSpace(r.URL.Query().Get("model"))
	}
	if isWebSocketUpgrade(r) {
		meta.Stream = true
	}
	return meta
}

func readFormRequestMeta(body []byte, contentType string, meta requestMeta) requestMeta {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return meta
	}
	switch mediaType {
	case "application/x-www-form-urlencoded":
		values, parseErr := url.ParseQuery(string(body))
		if parseErr == nil {
			meta.Model = strings.TrimSpace(values.Get("model"))
			meta.Stream, _ = strconv.ParseBool(values.Get("stream"))
			meta.ImageCount, _ = strconv.Atoi(values.Get("n"))
		}
	case "multipart/form-data":
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return meta
		}
		reader := multipart.NewReader(bytes.NewReader(body), boundary)
		for {
			part, partErr := reader.NextPart()
			if partErr != nil {
				break
			}
			name := part.FormName()
			if part.FileName() != "" || (name != "model" && name != "stream" && name != "n") {
				_ = part.Close()
				continue
			}
			value, _ := io.ReadAll(io.LimitReader(part, 4<<10))
			_ = part.Close()
			switch name {
			case "model":
				meta.Model = strings.TrimSpace(string(value))
			case "stream":
				meta.Stream, _ = strconv.ParseBool(strings.TrimSpace(string(value)))
			case "n":
				meta.ImageCount, _ = strconv.Atoi(strings.TrimSpace(string(value)))
			}
		}
	}
	return meta
}

func resolveAPIKeyModel(requested string, aliases []store.APIKeyModelAlias) requestMeta {
	requested = strings.TrimSpace(requested)
	result := requestMeta{Model: requested, RequestedModel: requested}
	for _, item := range aliases {
		if strings.EqualFold(strings.TrimSpace(item.Alias), requested) {
			result.Model = strings.TrimSpace(item.Model)
			result.ModelAlias = requested
			break
		}
	}
	return result
}

func rewriteRequestModel(body []byte, requestURL *url.URL, requested, actual string) ([]byte, error) {
	if requested == "" || actual == "" || strings.EqualFold(requested, actual) {
		return body, nil
	}
	if result := gjson.GetBytes(body, "model"); result.Type == gjson.String && result.Index > 0 &&
		strings.EqualFold(strings.TrimSpace(result.String()), requested) {
		replacement, _ := json.Marshal(actual)
		end := result.Index + len(result.Raw)
		if end <= len(body) {
			rewritten := make([]byte, len(body)-len(result.Raw)+len(replacement))
			at := copy(rewritten, body[:result.Index])
			at += copy(rewritten[at:], replacement)
			copy(rewritten[at:], body[end:])
			body = rewritten
		}
	}
	query := requestURL.Query()
	if strings.EqualFold(strings.TrimSpace(query.Get("model")), requested) {
		query.Set("model", actual)
		requestURL.RawQuery = query.Encode()
	}
	return body, nil
}

func readBoundedRequestBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	reader := http.MaxBytesReader(w, r.Body, limit)
	var buffer bytes.Buffer
	// io.ReadAll grows geometrically without knowing the HTTP content length.
	// Large JSON requests are common here, so reserve the exact known size and
	// avoid retaining a substantially oversized backing array.
	if r.ContentLength > 0 && r.ContentLength <= limit {
		buffer.Grow(int(r.ContentLength))
	}
	_, err := buffer.ReadFrom(reader)
	return buffer.Bytes(), err
}

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
	onHeader  func()
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
	if w.onHeader != nil {
		w.onHeader()
	}
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

type priceLookupResult struct {
	price store.ResolvedPrice
	err   error
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

func publicError(status int, code, message string) userFacingError {
	return userFacingError{Status: status, Code: code, Message: message, Retryable: defaultErrorRetryable(status, code)}
}

func (a *App) rejectPublic(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, body []byte, started time.Time, timeline *latencyTimeline, classified userFacingError) {
	writeUserFacingError(w, classified)
	a.logRejectedRequest(r, key, requestID, admission, meta, body, started, timeline, classified)
}

func (a *App) logRejectedRequest(r *http.Request, key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, body []byte, started time.Time, timeline *latencyTimeline, classified userFacingError) {
	detail := rejectedRequestDetail(r, body, classified.Code, classified.Message, started, timeline)
	a.writeRejectedRequestLog(key, requestID, admission, meta, r, classified.Status, started, classified.Code, classified.Message, detail)
}

func admissionAuthIndex(admission store.Admission) string {
	return firstNonEmptyString(admission.UpstreamCredentialID, admission.UpstreamAuthIndex)
}

func requestPriceDimensions(key store.KeyContext, meta requestMeta, path, authIndex, responseTier string) pricing.Dimensions {
	return pricing.Dimensions{
		APIGroupKey: key.ID, Model: meta.Model, AuthIndex: authIndex,
		ServiceTier: meta.ServiceTier, ResponseServiceTier: responseTier,
		ReasoningEffort: meta.ReasoningEffort, Endpoint: path,
	}
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

func (a *App) handlePublic(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	timeline := newLatencyTimeline(started)
	if retiredProtocolPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, "unsupported_protocol", "RelayAPI 仅支持 Responses 和 OpenAI 兼容协议")
		return
	}
	key, err := a.store.ResolveKey(r.Context(), bearer(r))
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	timeline.Step(time.Now(), "resolve_key", "解析 API Key", "relay", "鉴权并加载租户与 Key 权限")
	if isNativeModelCatalogRequest(r) {
		a.serveModelCatalog(w, r, key)
		return
	}
	requestID := identity.NewID()
	w.Header().Set("X-Relay-Request-ID", requestID)
	admission := store.Admission{RequestID: requestID}
	expectedBodyBytes := r.ContentLength
	if expectedBodyBytes < 0 || expectedBodyBytes > a.cfg.MaxRequestBytes {
		expectedBodyBytes = a.cfg.MaxRequestBytes
	}
	targetAdmission := a.admission()
	if targetAdmission == nil || a.nativeRuntime == nil {
		a.rejectPublic(w, r, key, requestID, admission, requestMetadata(nil, r), nil, started, timeline,
			publicError(http.StatusServiceUnavailable, "runtime_unavailable", "模型运行时不可用"))
		return
	}
	lease, err := targetAdmission.Acquire(r.Context(), expectedBodyBytes)
	if err != nil {
		classified := writeAdmissionError(w, err, targetAdmission.AdmissionStatus())
		a.logRejectedRequest(r, key, requestID, admission, requestMetadata(nil, r), nil, started, timeline, classified)
		return
	}
	defer lease.Release()
	timeline.Step(time.Now(), "runtime_admission_queue", "运行时准入排队", "queue", "等待并发槽位与请求体内存预算")

	body, err := readBoundedRequestBody(w, r, a.cfg.MaxRequestBytes)
	if err != nil {
		a.rejectPublic(w, r, key, requestID, admission, requestMetadata(body, r), body, started, timeline,
			publicError(http.StatusRequestEntityTooLarge, "body_too_large", fmt.Sprintf("请求体超过 %d MiB", a.cfg.MaxRequestBytes>>20)))
		return
	}
	if len(body) >= largeRequestMemoryReleaseBytes {
		defer a.reclaimAfterLargeRequest(len(body))
	}
	timeline.Step(time.Now(), "read_request_body", "读取客户端请求", "downstream", "读取并缓存客户端请求体")
	originalBody := body
	logContext := requestLogContext{requestBytes: int64(len(body))}
	meta := requestMetadata(body, r)
	resolved := resolveAPIKeyModel(meta.Model, key.ModelAliases)
	resolved.RequestedModel = meta.Model
	resolved.Stream = meta.Stream
	resolved.ServiceTier = meta.ServiceTier
	resolved.ReasoningEffort = meta.ReasoningEffort
	resolved.ImageCount = meta.ImageCount
	meta = resolved
	body, err = rewriteRequestModel(body, r.URL, meta.RequestedModel, meta.Model)
	if err != nil {
		a.rejectPublic(w, r, key, requestID, admission, meta, body, started, timeline,
			publicError(http.StatusBadRequest, "invalid_request", "无法改写请求模型"))
		return
	}
	websocket := isWebSocketUpgrade(r)
	billable := meta.Model != "" && (websocket || (r.Method != http.MethodGet && r.Method != http.MethodHead))
	if meta.Model != "" && !key.AllowsModel(meta.Model) {
		a.rejectPublic(w, r, key, requestID, admission, meta, body, started, timeline,
			publicError(http.StatusForbidden, "model_not_allowed", "该 API Key 无权使用此模型"))
		return
	}
	timeline.Step(time.Now(), "model_resolution", "模型解析与权限", "relay", "解析别名、改写模型并检查 Key 模型权限")
	var basePriceResult <-chan priceLookupResult
	if billable {
		result := make(chan priceLookupResult, 1)
		basePriceResult = result
		dimensions := requestPriceDimensions(key, meta, r.URL.Path, "", "")
		// Daily-limit aggregation and price resolution are independent reads.
		// Starting the price lookup here removes one database round trip from the
		// critical path whenever a key also has a daily token limit.
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			price, lookupErr := a.store.ResolvePrice(r.Context(), dimensions)
			result <- priceLookupResult{price: price, err: lookupErr}
		}()
	}
	if err := a.enforceLimits(r.Context(), key); err != nil {
		classified := publicError(http.StatusInternalServerError, "usage_limit_check_failed", "暂时无法检查使用限制，请稍后重试")
		var limitErr *requestLimitError
		if errors.As(err, &limitErr) {
			classified = publicError(http.StatusTooManyRequests, limitErr.Code, limitErr.Message)
		}
		classified.Retryable = true
		a.rejectPublic(w, r, key, requestID, admission, meta, body, started, timeline, classified)
		return
	}
	timeline.Step(time.Now(), "usage_limits", "用量限制检查", "relay", "检查 Key 与租户的请求限制")

	var price store.ResolvedPrice
	var priceSnapshot []byte
	priceConfigured := false
	var deferredAdmissionPrice <-chan priceLookupResult
	if billable {
		lookup := <-basePriceResult
		price, err = lookup.price, lookup.err
		if err != nil {
			if a.cfg.UnpricedModelPolicy == "deny" {
				a.rejectPublic(w, r, key, requestID, admission, meta, body, started, timeline,
					publicError(http.StatusServiceUnavailable, "pricing_unavailable", "该模型尚未配置价格，请联系管理员完善计费配置"))
				return
			}
		} else {
			priceConfigured = true
		}
		priceSnapshot = store.EncodePriceSnapshot(price)
		reserve := int64(0)
		if priceConfigured {
			reserve = a.cfg.ReservationNanoUSD
			if price.ImageOutputNanoUSDPerToken > 0 {
				imageCount := int64(meta.ImageCount)
				if imageCount < 1 {
					imageCount = 1
				}
				reserve = max64(reserve, saturatingMultiply64(a.cfg.ImageReservationNanoUSD, imageCount))
			}
		}
		reservationTTL := maxDuration(30*time.Minute, a.cfg.RequestTimeout+5*time.Minute)
		if websocket {
			reservationTTL = 24 * time.Hour
		}
		admission, err = a.store.AdmitRequest(r.Context(), store.AdmissionInput{
			RequestID: requestID, Key: key, Model: meta.Model,
			BalanceReserve: reserve, QuotaReserve: reserve, PriceConfigured: priceConfigured,
			PriceSnapshot: priceSnapshot, ExpiresAt: time.Now().Add(reservationTTL),
		})
		if err != nil {
			a.rejectPublic(w, r, key, requestID, admission, meta, body, started, timeline, admissionUserError(err))
			return
		}
		if priceConfigured {
			logContext.price = &price
			admissionPriceResult := make(chan priceLookupResult, 1)
			deferredAdmissionPrice = admissionPriceResult
			priceContext, cancelPriceLookup := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
			dimensions := requestPriceDimensions(key, meta, r.URL.Path, admissionAuthIndex(admission), "")
			a.wg.Add(1)
			go func() {
				defer a.wg.Done()
				defer cancelPriceLookup()
				resolvedPrice, resolveErr := a.store.ResolvePrice(priceContext, dimensions)
				if resolveErr == nil {
					resolvedSnapshot := store.EncodePriceSnapshot(resolvedPrice)
					if !bytes.Equal(resolvedSnapshot, priceSnapshot) {
						_ = a.store.UpdateReservationPriceSnapshot(priceContext, requestID, resolvedSnapshot)
					}
				}
				admissionPriceResult <- priceLookupResult{price: resolvedPrice, err: resolveErr}
			}()
		}
	}
	if websocket && deferredAdmissionPrice != nil {
		// WebSocket settlement spans multiple turns and receives its price at
		// session construction, so it cannot defer this lookup to HTTP response
		// finalization. HTTP streaming keeps the lookup off its first-byte path.
		lookup := <-deferredAdmissionPrice
		if lookup.err == nil {
			price = lookup.price
			logContext.price = &price
		}
		deferredAdmissionPrice = nil
	}
	timeline.Step(time.Now(), "billing_admission", "订阅准入与预留", "billing", "解析价格、选择订阅与凭据并预留余额或额度")

	if websocket {
		r.Body = io.NopCloser(bytes.NewReader(body))
		a.handleWebSocket(w, r, key, requestID, admission, meta, started, billable, logContext, timeline)
		return
	}
	a.serveInference(w, r, publicInference{
		key: key, requestID: requestID, admission: admission, meta: meta,
		body: body, originalBody: originalBody, started: started, timeline: timeline,
		billable: billable, logContext: logContext, price: price, priceConfigured: priceConfigured,
		deferredAdmissionPrice: deferredAdmissionPrice, targetAdmission: targetAdmission,
	})
}

func (a *App) serveInference(w http.ResponseWriter, r *http.Request, call publicInference) {
	prepareRuntimeHeaders(r.Header, call.requestID, call.admission.UpstreamCredentialID)
	if isCodexResponsesPath(r.URL.Path) {
		w.Header().Set("X-Models-Etag", modelCatalogRevision(call.key, a.nativeRuntime.Models(), "codex-capabilities=full-v1"))
	}
	if call.admission.ChildSubscriptionID != "" {
		w.Header().Set("X-Relay-Subscription-ID", call.admission.ChildSubscriptionID)
	}
	call.timeline.Step(time.Now(), "prepare_runtime_request", "准备运行时请求", "relay", "去掉客户端凭据头并钉住上游账户")
	capture := &rollingCapture{max: 2 << 20}
	var firstByteAt, headerAt time.Time
	out := &runtimeWriter{client: w, stream: call.meta.Stream, capture: capture, firstByte: func() {
		if firstByteAt.IsZero() {
			firstByteAt = time.Now()
		}
	}, onHeader: func() {
		if headerAt.IsZero() {
			headerAt = time.Now()
		}
	}}
	a.nativeRuntime.Serve(out, r, call.body)
	if !headerAt.IsZero() {
		call.timeline.Step(headerAt, "runtime_response_headers", "运行时返回响应头", "runtime", "进程内调用原生运行时，包含凭据路由与供应商等待")
	}
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
		logContext.upstreamTraceID = strings.TrimSpace(upstreamHeaders.Get("X-Upstream-TRACE-ID"))
		logContext.responseBytes = responseBytes
		if !firstByteAt.IsZero() {
			ttft := firstByteAt.Sub(call.started).Milliseconds()
			logContext.ttftMS = &ttft
			call.timeline.Step(firstByteAt, "runtime_first_body", "等待首个响应数据", "runtime", "运行时已返回响应头，继续等待首个响应正文数据")
			call.timeline.Mark(firstByteAt, "first_byte", "首字节")
		}
		call.timeline.Step(responseReadAt, "response_transfer", "响应传输", "downstream", "运行时直接写入客户端响应")
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

func saturatingMultiply64(left, right int64) int64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

func retiredProtocolPath(path string) bool {
	path = strings.TrimRight(strings.TrimSpace(path), "/")
	return path == "/v1/messages" || path == "/v1/messages/count_tokens" || strings.HasPrefix(path, "/v1beta/")
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

type streamCopyError struct {
	operation string
	err       error
}

func (e *streamCopyError) Error() string { return e.operation + ": " + e.err.Error() }
func (e *streamCopyError) Unwrap() error { return e.err }

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

func writeAdmissionError(w http.ResponseWriter, err error, status gateway.AdmissionStatus) userFacingError {
	retryAfter := int64(1)
	httpStatus := http.StatusServiceUnavailable
	retryable := true
	code := "upstream_overloaded"
	message := "运行时当前并发已达到安全上限，请稍后重试"
	switch {
	case errors.Is(err, context.Canceled):
		httpStatus = 499
		retryable = false
		code = "client_canceled"
		message = "请求已由客户端取消"
	case errors.Is(err, context.DeadlineExceeded):
		httpStatus = http.StatusGatewayTimeout
		code = "request_timeout"
		message = "请求在等待运行时准入时超时"
	case errors.Is(err, gateway.ErrCircuitOpen):
		code = "upstream_circuit_open"
		message = "运行时正在从连续故障中恢复，请稍后重试"
		if status.RetryAfterMS > 0 {
			retryAfter = (status.RetryAfterMS + 999) / 1000
		}
	}
	if retryable {
		w.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
	}
	w.Header().Set("X-Relay-Error-Code", code)
	details := map[string]any{"retryable": retryable}
	if retryable {
		details["retry_after_seconds"] = retryAfter
	}
	writeJSON(w, httpStatus, map[string]any{"error": map[string]any{
		"code": code, "type": "service_unavailable", "message": message,
		"details": details,
	}})
	return userFacingError{Status: httpStatus, Code: code, Message: message, Retryable: retryable}
}

func (a *App) releaseReservation(requestID string, billable bool) {
	if !billable {
		return
	}
	if err := a.store.ReleaseRequestReservation(context.Background(), requestID); err != nil {
		slog.Error("release request reservation", "request_id", requestID, "error", err)
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

type requestLimitError struct {
	Code    string
	Message string
}

func (e *requestLimitError) Error() string { return e.Message }

func (a *App) enforceLimits(ctx context.Context, key store.KeyContext) error {
	if key.TenantTokenLimit != nil || key.TokenLimitDaily != nil {
		tenantTokens, keyTokens, err := a.store.DailyTokens(ctx, key.TenantID, key.ID)
		if err != nil {
			return err
		}
		if key.TenantTokenLimit != nil && tenantTokens >= *key.TenantTokenLimit {
			return &requestLimitError{Code: "tenant_daily_token_limit_exceeded", Message: "租户今日 Token 使用额度已用尽，请等待次日重置"}
		}
		if key.TokenLimitDaily != nil && keyTokens >= *key.TokenLimitDaily {
			return &requestLimitError{Code: "api_key_daily_token_limit_exceeded", Message: "该 API Key 今日 Token 使用额度已用尽，请等待次日重置"}
		}
	}
	// Per-minute admission is intentionally process-local; PostgreSQL remains the source of truth for billing.
	limit := key.RateLimitPerMinute
	if limit == nil {
		limit = key.TenantRateLimit
	}
	if limit != nil && !a.allowRate(key.ID, *limit) {
		return &requestLimitError{Code: "api_key_rate_limit_exceeded", Message: "该 API Key 每分钟请求次数已达上限，请稍后重试"}
	}
	return nil
}

func setStreamingHeaders(header http.Header, stream bool) {
	if !stream {
		return
	}
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("X-Accel-Buffering", "no")
}

func expired(value *time.Time) bool { return value != nil && !value.After(time.Now()) }

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
