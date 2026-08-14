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
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
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
	Reasoning       struct {
		Effort string `json:"effort"`
	} `json:"reasoning"`
	RequestedModel string `json:"-"`
	ModelAlias     string `json:"-"`
}

func readRequestMeta(body []byte, _ string) requestMeta {
	var meta requestMeta
	_ = json.Unmarshal(body, &meta)
	if meta.ReasoningEffort == "" {
		meta.ReasoningEffort = meta.Reasoning.Effort
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

func releaseBufferedRequest(upstream *http.Request, response *http.Response) {
	if upstream != nil {
		upstream.Body = nil
		upstream.GetBody = nil
	}
	if response != nil && response.Request != nil {
		response.Request.Body = nil
		response.Request.GetBody = nil
	}
}

type rollingCapture struct {
	mu     sync.Mutex
	buf    []byte
	detail []byte
	max    int
	total  int64
}

type flushingCaptureWriter struct {
	response http.ResponseWriter
	capture  io.Writer
}

func (w *flushingCaptureWriter) Write(payload []byte) (int, error) {
	if len(payload) > 0 && w.capture != nil {
		_, _ = w.capture.Write(payload)
	}
	n, err := w.response.Write(payload)
	if flusher, ok := w.response.(http.Flusher); ok {
		flusher.Flush()
	}
	return n, err
}

func (c *rollingCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	if len(c.detail) < requestLogDetailLimit {
		remaining := requestLogDetailLimit - len(c.detail)
		if remaining > len(p) {
			remaining = len(p)
		}
		c.detail = append(c.detail, p[:remaining]...)
	}
	if len(p) >= c.max {
		c.buf = append(c.buf[:0], p[len(p)-c.max:]...)
	} else {
		overflow := len(c.buf) + len(p) - c.max
		if overflow > 0 {
			c.buf = append(c.buf[:0], c.buf[overflow:]...)
		}
		c.buf = append(c.buf, p...)
	}
	return len(p), nil
}
func (c *rollingCapture) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buf...)
}
func (c *rollingCapture) Info() ([]byte, bool, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.detail...), c.total > int64(len(c.detail)), c.total
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
}

func rejectedRequestDetail(r *http.Request, body []byte, _ bool, code, message string, started time.Time, timeline ...*latencyTimeline) *store.LogDetailInput {
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

func (a *App) proxy(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	timeline := newLatencyTimeline(started)
	if retiredProtocolPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, "unsupported_protocol", "RelayAPI 仅支持 Responses 和 OpenAI 兼容协议")
		return
	}
	keyValue := bearer(r)
	key, err := a.store.ResolveKey(r.Context(), keyValue)
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	keyResolvedAt := time.Now()
	timeline.Step(keyResolvedAt, "resolve_key", "解析 API Key", "relay", "鉴权并加载租户与 Key 权限")
	if isNativeModelCatalogRequest(r) {
		a.proxyNativeModels(w, r, key)
		return
	}
	requestID := identity.NewID()
	w.Header().Set("X-Relay-Request-ID", requestID)
	admission := store.Admission{RequestID: requestID}
	expectedBodyBytes := r.ContentLength
	if expectedBodyBytes < 0 || expectedBodyBytes > a.cfg.MaxRequestBytes {
		expectedBodyBytes = a.cfg.MaxRequestBytes
	}
	targetUpstream := a.inferenceGateway()
	lease, err := targetUpstream.Acquire(r.Context(), expectedBodyBytes)
	if err != nil {
		classified := writeGatewayAdmissionError(w, err, targetUpstream.AdmissionStatus())
		meta := requestMetadata(nil, r)
		detail := rejectedRequestDetail(r, nil, false, classified.Code, classified.Message, started, timeline)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, classified.Status, started, classified.Code, classified.Message, detail)
		return
	}
	defer lease.Release()
	leaseAcquiredAt := time.Now()
	timeline.Step(leaseAcquiredAt, "upstream_admission_queue", "Upstream 准入排队", "queue", "等待并发槽位与请求体内存预算")

	body, err := readBoundedRequestBody(w, r, a.cfg.MaxRequestBytes)
	if err != nil {
		message := fmt.Sprintf("请求体超过 %d MiB", a.cfg.MaxRequestBytes>>20)
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", message)
		meta := requestMetadata(body, r)
		detail := rejectedRequestDetail(r, body, true, "body_too_large", message, started, timeline)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusRequestEntityTooLarge, started, "body_too_large", message, detail)
		return
	}
	bufferedBodyBytes := len(body)
	if bufferedBodyBytes >= largeRequestMemoryReleaseBytes {
		defer a.reclaimAfterLargeRequest(bufferedBodyBytes)
	}
	bodyReadAt := time.Now()
	timeline.Step(bodyReadAt, "read_request_body", "读取客户端请求", "downstream", "读取并缓存客户端请求体")
	originalBody := body
	logContext := requestLogContext{detail: baseRequestDetail(r, body), requestBytes: int64(len(body))}
	meta := requestMetadata(body, r)
	clientRequestedModel := meta.Model
	resolved := resolveAPIKeyModel(meta.Model, key.ModelAliases)
	resolved.RequestedModel = clientRequestedModel
	resolved.Stream = meta.Stream
	resolved.ServiceTier = meta.ServiceTier
	resolved.ReasoningEffort = meta.ReasoningEffort
	resolved.ImageCount = meta.ImageCount
	meta = resolved
	body, err = rewriteRequestModel(body, r.URL, meta.RequestedModel, meta.Model)
	if err != nil {
		const message = "无法改写请求模型"
		writeError(w, http.StatusBadRequest, "invalid_request", message)
		detail := rejectedRequestDetail(r, body, true, "invalid_request", message, started, timeline)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusBadRequest, started, "invalid_request", message, detail)
		return
	}
	websocket := isWebSocketUpgrade(r)
	billable := meta.Model != "" && (websocket || (r.Method != http.MethodGet && r.Method != http.MethodHead))
	if meta.Model != "" && !key.AllowsModel(meta.Model) {
		const message = "该 API Key 无权使用此模型"
		writeError(w, http.StatusForbidden, "model_not_allowed", message)
		detail := rejectedRequestDetail(r, body, true, "model_not_allowed", message, started, timeline)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusForbidden, started, "model_not_allowed", message, detail)
		return
	}
	modelResolvedAt := time.Now()
	timeline.Step(modelResolvedAt, "model_resolution", "模型解析与权限", "relay", "解析别名、改写模型并检查 Key 模型权限")
	if err := a.enforceLimits(r.Context(), key); err != nil {
		classified := userFacingError{Status: http.StatusInternalServerError, Code: "usage_limit_check_failed", Message: "暂时无法检查使用限制，请稍后重试", Retryable: true}
		var limitErr *requestLimitError
		if errors.As(err, &limitErr) {
			classified = userFacingError{Status: http.StatusTooManyRequests, Code: limitErr.Code, Message: limitErr.Message, Retryable: true}
		}
		writeUserFacingError(w, classified)
		detail := rejectedRequestDetail(r, body, true, classified.Code, classified.Message, started, timeline)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, classified.Status, started, classified.Code, classified.Message, detail)
		return
	}
	limitsCheckedAt := time.Now()
	timeline.Step(limitsCheckedAt, "usage_limits", "用量限制检查", "relay", "检查 Key 与租户的请求限制")

	var price store.ResolvedPrice
	var priceSnapshot []byte
	priceConfigured := false
	if billable {
		price, err = a.store.ResolvePrice(r.Context(), pricing.Dimensions{
			APIGroupKey: key.ID, Model: meta.Model, ServiceTier: meta.ServiceTier,
			ReasoningEffort: meta.ReasoningEffort, Endpoint: r.URL.Path,
		})
		if err != nil {
			if a.cfg.UnpricedModelPolicy == "deny" {
				const message = "该模型尚未配置价格，请联系管理员完善计费配置"
				writeError(w, http.StatusServiceUnavailable, "pricing_unavailable", message)
				detail := rejectedRequestDetail(r, body, true, "pricing_unavailable", message, started, timeline)
				a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusServiceUnavailable, started, "pricing_unavailable", message, detail)
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
			classified := admissionUserError(err)
			writeUserFacingError(w, classified)
			detail := rejectedRequestDetail(r, body, true, classified.Code, classified.Message, started, timeline)
			a.writeRejectedRequestLog(key, requestID, admission, meta, r, classified.Status, started, classified.Code, classified.Message, detail)
			return
		}
		if priceConfigured {
			if resolved, resolveErr := a.store.ResolvePrice(r.Context(), pricing.Dimensions{
				APIGroupKey: key.ID, Model: meta.Model, AuthIndex: admission.UpstreamAuthIndex,
				ServiceTier: meta.ServiceTier, ReasoningEffort: meta.ReasoningEffort, Endpoint: r.URL.Path,
			}); resolveErr == nil {
				price = resolved
				resolvedSnapshot := store.EncodePriceSnapshot(price)
				if !bytes.Equal(resolvedSnapshot, priceSnapshot) {
					_ = a.store.UpdateReservationPriceSnapshot(r.Context(), requestID, resolvedSnapshot)
					priceSnapshot = resolvedSnapshot
				}
			}
			logContext.price = &price
		}
	}
	admittedAt := time.Now()
	timeline.Step(admittedAt, "billing_admission", "订阅准入与预留", "billing", "解析价格、选择订阅与凭据并预留余额或额度")

	if websocket {
		r.Body = io.NopCloser(bytes.NewReader(body))
		a.proxyNativeWebSocket(w, r, key, requestID, admission, meta, started, billable, logContext, timeline)
		return
	}

	var response *http.Response
	target := targetUpstream.URL(r.URL.RequestURI())
	var upstream *http.Request
	clientTraceState, clientTrace := newClientHTTPTrace()
	transportStarted := false
	upstream, err = http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err == nil {
		upstream = upstream.WithContext(httptrace.WithClientTrace(upstream.Context(), clientTrace))
		copyHeaders(upstream.Header, r.Header)
		upstream.Header.Set("Authorization", "Bearer "+targetUpstream.APIKey)
		upstream.Header.Del("X-API-Key")
		upstream.Header.Del("X-Goog-API-Key")
		upstream.Header.Set("X-Relay-Request-ID", requestID)
		if admission.UpstreamCredentialID != "" {
			upstream.Header.Set("X-Relay-Upstream-Credential-ID", admission.UpstreamCredentialID)
		}
		upstream.Host = targetUpstream.BaseURL.Host
		logContext.detail.ForwardedHeaders = sanitizedHeaders(upstream.Header)
		captureForwardedRequest(logContext.detail, originalBody, body)
		logContext.forwardedBytes = int64(len(body))
		timeline.Step(time.Now(), "prepare_upstream_request", "准备 Upstream 请求", "relay", "构造 Upstream 请求、改写正文并准备安全转发头")
		transportStarted = true
		response, err = targetUpstream.HTTP.Do(upstream)
	} else {
		timeline.Step(time.Now(), "prepare_upstream_request", "准备 Upstream 请求", "relay", "构造 Upstream 请求失败")
	}
	upstreamResultAt := time.Now()
	if transportStarted {
		timeline.AddHTTPTrace(clientTraceState, upstreamResultAt)
	}
	// The transport has completely sent the request by the time Do returns.
	// Break the response -> request -> bytes.Reader retention chain before a
	// potentially long SSE response keeps the full client payload alive.
	releaseBufferedRequest(upstream, response)
	body = nil
	originalBody = nil
	upstream = nil
	if err != nil {
		if r.Context().Err() == nil {
			targetUpstream.RecordTransportResult(err)
		}
		a.releaseReservation(requestID, billable)
		classified := classifyUpstreamTransportError(err, r.Context().Err(), "awaiting_headers")
		logContext.errorCode = classified.Code
		logContext.detail.ErrorName = "upstream_error"
		logContext.detail.ErrorMessage = err.Error()
		completed := time.Now()
		timeline.Step(completed, "relay_transport_error", "处理传输错误", "relay", "归类 Upstream 连接错误并释放预留")
		logContext.detail.StageTimings = timeline.JSON(completed)
		logContext.stageTimings = logContext.detail.StageTimings
		a.writeRequestLog(key, requestID, admission, meta, r, 0, started, nil, false, true, 0, err.Error(), logContext)
		writeUpstreamTransportError(w, r, err, "awaiting_headers", requestID)
		return
	}
	targetUpstream.RecordTransportResult(nil)
	defer response.Body.Close()
	clientStatus := response.StatusCode
	var normalizedError *userFacingError
	capture := &rollingCapture{max: 2 << 20}
	var firstByteAt time.Time
	firstByte := func() {
		if firstByteAt.IsZero() {
			firstByteAt = time.Now()
		}
	}
	var copyErr error

	copyHeaders(w.Header(), response.Header)
	w.Header().Set("X-Relay-Request-ID", requestID)
	if isCodexResponsesPath(r.URL.Path) && a.nativeRuntime != nil {
		w.Header().Set("X-Models-Etag", modelCatalogRevision(key, a.nativeRuntime.Models(), "capability-policy="+a.codexCapabilityPolicy()))
	}
	if admission.ChildSubscriptionID != "" {
		w.Header().Set("X-Relay-Subscription-ID", admission.ChildSubscriptionID)
	}
	if response.StatusCode >= http.StatusBadRequest {
		// Upstream and providers sometimes use 429 for scheduler/auth failures. Read
		// the small error body before committing headers so Relay can report the
		// actual user-facing cause. Successful streaming responses remain direct.
		payload, readErr := io.ReadAll(io.LimitReader(&observedReader{Reader: response.Body, onFirstByte: firstByte}, int64(capture.max+1)))
		_, _ = capture.Write(payload)
		classified := a.classifyUpstreamError(response.StatusCode, payload, admission)
		if readErr != nil {
			copyErr = &streamCopyError{operation: "read_upstream", err: readErr}
			classified = userFacingError{Status: http.StatusBadGateway, Code: "upstream_connection_lost", Message: "读取模型服务错误响应时连接中断，请稍后重试", Retryable: true, UpstreamStatus: response.StatusCode}
		}
		normalizedError = &classified
		clientStatus = classified.Status
		for _, header := range []string{"Content-Length", "Content-Encoding", "Content-Range", "ETag"} {
			w.Header().Del(header)
		}
		if !classified.Retryable {
			w.Header().Del("Retry-After")
		}
		firstByte()
		writeUserFacingError(w, classified)
	} else {
		setStreamingHeaders(w.Header(), meta.Stream)
		w.WriteHeader(response.StatusCode)
		if meta.Stream {
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		copyErr = copyStreaming(w, io.TeeReader(response.Body, capture), firstByte)
	}
	responseReadAt := time.Now()
	if isUpstreamStreamError(copyErr) && r.Context().Err() == nil {
		targetUpstream.RecordTransportResult(copyErr)
	}

	parsed := billing.ParseResponse(capture.Bytes())
	if priceConfigured && parsed.ResponseServiceTier != "" {
		if resolved, resolveErr := a.store.ResolvePrice(r.Context(), pricing.Dimensions{
			APIGroupKey: key.ID, Model: meta.Model, AuthIndex: admission.UpstreamAuthIndex,
			ServiceTier: meta.ServiceTier, ResponseServiceTier: parsed.ResponseServiceTier,
			ReasoningEffort: meta.ReasoningEffort, Endpoint: r.URL.Path,
		}); resolveErr == nil {
			price = resolved
			logContext.price = &price
			_ = a.store.UpdateReservationPriceSnapshot(r.Context(), requestID, store.EncodePriceSnapshot(price))
		}
	}
	actual := int64(0)
	settled := !billable
	var cost *int64
	if billable && response.StatusCode < http.StatusBadRequest && parsed.Found && priceConfigured && billing.UsageComplete(price, parsed.Usage) {
		actual = billing.Cost(price, parsed.Usage)
		cost = &actual
		if err := a.store.SettleRequestReservation(context.WithoutCancel(r.Context()), requestID, actual, true); err == nil {
			settled = true
		} else {
			slog.Error("settle request", "request_id", requestID, "error", err)
		}
	} else if billable && response.StatusCode < http.StatusBadRequest {
		// Missing usage must not become free parent capacity. Conservatively
		// settle the reservation and keep pricing_complete=false for reconciliation.
		actual = max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
		if err := a.store.SettleRequestReservation(context.WithoutCancel(r.Context()), requestID, actual, false); err == nil {
			settled = true
		} else {
			slog.Error("settle incomplete request", "request_id", requestID, "error", err)
		}
	} else if billable {
		a.releaseReservation(requestID, true)
		settled = true
	}
	errorMessage := ""
	if copyErr != nil && normalizedError == nil {
		errorMessage = copyErr.Error()
		logContext.errorCode = "stream_copy_error"
	}
	rawResponse, responseTruncated, responseBytes := capture.Info()
	logContext.upstreamTraceID = strings.TrimSpace(response.Header.Get("X-Upstream-TRACE-ID"))
	logContext.detail.UpstreamStatus = response.StatusCode
	logContext.detail.UpstreamHeaders = sanitizedHeaders(response.Header)
	logContext.detail.UpstreamBody, _, _ = boundedDetail(rawResponse)
	logContext.detail.UpstreamBodyTruncated = responseTruncated || responseBytes > requestLogDetailLimit
	logContext.detail.UpstreamBodyBytes = responseBytes
	logContext.responseBytes = responseBytes
	if !firstByteAt.IsZero() {
		ttft := firstByteAt.Sub(started).Milliseconds()
		logContext.ttftMS = &ttft
		timeline.Step(firstByteAt, "upstream_first_body", "等待首个响应数据", "upstream", "Upstream 已返回响应头，继续等待首个响应正文数据")
		timeline.Mark(firstByteAt, "first_byte", "首字节")
	}
	timeline.Step(responseReadAt, "response_transfer", "响应传输", "downstream", "读取 上游响应并持续写回客户端")
	if normalizedError != nil {
		logContext.errorCode = normalizedError.Code
		logContext.detail.ErrorName = logContext.errorCode
		logContext.detail.ErrorMessage = normalizedError.Message
		errorMessage = normalizedError.Message
	} else if response.StatusCode >= http.StatusBadRequest && logContext.errorCode == "" {
		logContext.errorCode = "upstream_http_error"
		logContext.detail.ErrorName = logContext.errorCode
		errorMessage = upstreamErrorMessage(response.StatusCode, rawResponse)
	}
	if copyErr != nil && normalizedError == nil {
		logContext.detail.ErrorName = "stream_copy_error"
		logContext.detail.ErrorMessage = copyErr.Error()
	}
	completed := time.Now()
	timeline.Step(completed, "usage_and_settlement", "用量解析与结算", "billing", "解析 usage、计算费用并结算请求预留")
	timeline.Mark(completed, "complete", "请求完成")
	logContext.detail.StageTimings = timeline.JSON(completed)
	logContext.stageTimings = logContext.detail.StageTimings
	a.writeRequestLog(key, requestID, admission, meta, r, clientStatus, started, &parsed, cost != nil, settled, actual, errorMessage, logContext)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
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
	return store.LogInput{
		ID: requestID, TenantID: key.TenantID, APIKeyID: key.ID, UpstreamRequestID: upstreamID, Model: meta.Model,
		UpstreamTraceID: logContext.upstreamTraceID, RequestedModel: meta.RequestedModel, ActualModel: meta.Model, ModelAlias: meta.ModelAlias, TenantName: key.TenantName,
		APIKeyName: key.Name, APIKeyPrefix: key.Prefix, RequestType: requestType(r.URL.Path, isWebSocketUpgrade(r)),
		ServiceTier: meta.ServiceTier, ResponseServiceTier: parsedResponseServiceTier(parsed), ReasoningEffort: meta.ReasoningEffort,
		ClientName: client.Name, ClientVersion: client.Version, UserAgent: client.UserAgent,
		AuthIndex: admission.UpstreamAuthIndex, ParentSubscriptionID: admission.ParentSubscriptionID,
		ChildSubscriptionID: admission.ChildSubscriptionID,
		Method:              r.Method, Path: r.URL.Path, StatusCode: status, Stream: meta.Stream, Usage: usage,
		CostNanoUSD: costPointer, Price: logContext.price, PricingComplete: pricingComplete, Settled: settled,
		ReservedNanoUSD: max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD), LatencyMS: time.Since(started).Milliseconds(),
		RequestBodyBytes: logContext.requestBytes, ForwardedBodyBytes: logContext.forwardedBytes, ResponseBodyBytes: logContext.responseBytes,
		TTFTMS: logContext.ttftMS, ErrorCode: logContext.errorCode, ErrorMessage: errorMessage,
		StageTimings: logContext.stageTimings,
		StartedAt:    started, CompletedAt: time.Now(), Detail: detail,
	}
}

func parsedResponseServiceTier(parsed *billing.Result) string {
	if parsed == nil {
		return ""
	}
	return parsed.ResponseServiceTier
}

func copyStreaming(w http.ResponseWriter, source io.Reader, onFirstByte func()) error {
	buffer := make([]byte, 32<<10)
	flusher, _ := w.(http.Flusher)
	for {
		n, err := source.Read(buffer)
		if n > 0 {
			if onFirstByte != nil {
				onFirstByte()
				onFirstByte = nil
			}
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return &streamCopyError{operation: "write_downstream", err: writeErr}
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return &streamCopyError{operation: "read_upstream", err: err}
		}
	}
}

type streamCopyError struct {
	operation string
	err       error
}

func (e *streamCopyError) Error() string { return e.operation + ": " + e.err.Error() }
func (e *streamCopyError) Unwrap() error { return e.err }

func isUpstreamStreamError(err error) bool {
	var copyErr *streamCopyError
	return errors.As(err, &copyErr) && copyErr.operation == "read_upstream"
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

func writeGatewayAdmissionError(w http.ResponseWriter, err error, status gateway.AdmissionStatus) upstreamTransportError {
	retryAfter := int64(1)
	httpStatus := http.StatusServiceUnavailable
	retryable := true
	code := "upstream_overloaded"
	message := "Upstream 当前并发已达到安全上限，请稍后重试"
	switch {
	case errors.Is(err, context.Canceled):
		httpStatus = 499
		retryable = false
		code = "client_canceled"
		message = "请求已由客户端取消"
	case errors.Is(err, context.DeadlineExceeded):
		httpStatus = http.StatusGatewayTimeout
		code = "request_timeout"
		message = "请求在等待 Upstream 准入时超时"
	case errors.Is(err, gateway.ErrCircuitOpen):
		code = "upstream_circuit_open"
		message = "Upstream 正在从连续故障中恢复，请稍后重试"
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
	return upstreamTransportError{Status: httpStatus, Code: code, Message: message, Phase: "admission", Retryable: retryable}
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

func hopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
