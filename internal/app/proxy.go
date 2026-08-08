package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

type requestMeta struct {
	Model           string `json:"model"`
	Stream          bool   `json:"stream"`
	ServiceTier     string `json:"service_tier"`
	ReasoningEffort string `json:"reasoning_effort"`
	Reasoning       struct {
		Effort string `json:"effort"`
	} `json:"reasoning"`
	RequestedModel string `json:"-"`
	ModelAlias     string `json:"-"`
}

func readRequestMeta(body []byte, requestPath string) requestMeta {
	var meta requestMeta
	_ = json.Unmarshal(body, &meta)
	if meta.ReasoningEffort == "" {
		meta.ReasoningEffort = meta.Reasoning.Effort
	}
	if meta.Model != "" {
		return meta
	}
	// Gemini's native API puts the model in
	// /v1beta/models/{model}:generateContent instead of the JSON body.
	const marker = "/models/"
	if index := strings.Index(requestPath, marker); index >= 0 {
		value := requestPath[index+len(marker):]
		if end := strings.IndexAny(value, ":/"); end >= 0 {
			value = value[:end]
		}
		meta.Model, _ = url.PathUnescape(value)
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
			if part.FileName() != "" || (name != "model" && name != "stream") {
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
	var object map[string]json.RawMessage
	if len(body) > 0 && json.Unmarshal(body, &object) == nil {
		if raw, exists := object["model"]; exists {
			var bodyModel string
			if json.Unmarshal(raw, &bodyModel) == nil && strings.EqualFold(strings.TrimSpace(bodyModel), requested) {
				replacement, _ := json.Marshal(actual)
				object["model"] = replacement
				var err error
				body, err = json.Marshal(object)
				if err != nil {
					return nil, err
				}
			}
		}
	}
	const marker = "/models/"
	if index := strings.Index(requestURL.Path, marker); index >= 0 {
		start := index + len(marker)
		end := len(requestURL.Path)
		if relative := strings.IndexAny(requestURL.Path[start:], ":/"); relative >= 0 {
			end = start + relative
		}
		if strings.EqualFold(requestURL.Path[start:end], requested) {
			requestURL.Path = requestURL.Path[:start] + actual + requestURL.Path[end:]
			requestURL.RawPath = ""
		}
	}
	query := requestURL.Query()
	if strings.EqualFold(strings.TrimSpace(query.Get("model")), requested) {
		query.Set("model", actual)
		requestURL.RawQuery = query.Encode()
	}
	return body, nil
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
	price      *store.ResolvedPrice
	detail     *store.LogDetailInput
	ttftMS     *int64
	cpaTraceID string
	errorCode  string
}

func rejectedRequestDetail(r *http.Request, body []byte, bodyRead bool, code, message string, started time.Time) *store.LogDetailInput {
	detail := baseRequestDetail(r, body)
	if !bodyRead && r.ContentLength > 0 {
		detail.RequestBodyBytes = r.ContentLength
		detail.RequestBodyTruncated = true
	}
	detail.ErrorName = code
	detail.ErrorMessage = boundedErrorText(message)
	detail.StageTimings = timingJSON(map[string]int64{"total_ms": time.Since(started).Milliseconds()})
	return detail
}

func (a *App) writeRejectedRequestLog(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta,
	r *http.Request, status int, started time.Time, code, message string, detail *store.LogDetailInput) {
	a.writeRequestLog(key, requestID, admission, meta, r, status, started, nil, false, true, 0,
		boundedErrorText(message), requestLogContext{detail: detail, errorCode: code})
}

func (a *App) proxy(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	keyValue := bearer(r)
	key, err := a.store.ResolveKey(r.Context(), keyValue)
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	keyResolvedAt := time.Now()
	if isNativeModelCatalogRequest(r) {
		a.proxyNativeModels(w, r, key)
		return
	}
	requestID := identity.NewID()
	admission := store.Admission{RequestID: requestID}
	expectedBodyBytes := r.ContentLength
	if expectedBodyBytes < 0 || expectedBodyBytes > a.cfg.CPAMaxRequestBytes {
		expectedBodyBytes = a.cfg.CPAMaxRequestBytes
	}
	targetCPA := a.inferenceCPA()
	lease, err := targetCPA.Acquire(r.Context(), expectedBodyBytes)
	if err != nil {
		classified := writeCPAAdmissionError(w, err, targetCPA.AdmissionStatus())
		meta := requestMetadata(nil, r)
		detail := rejectedRequestDetail(r, nil, false, classified.Code, classified.Message, started)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, classified.Status, started, classified.Code, classified.Message, detail)
		return
	}
	defer lease.Release()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, a.cfg.CPAMaxRequestBytes))
	if err != nil {
		message := fmt.Sprintf("请求体超过 %d MiB", a.cfg.CPAMaxRequestBytes>>20)
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", message)
		meta := requestMetadata(body, r)
		detail := rejectedRequestDetail(r, body, true, "body_too_large", message, started)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusRequestEntityTooLarge, started, "body_too_large", message, detail)
		return
	}
	bodyReadAt := time.Now()
	logContext := requestLogContext{detail: baseRequestDetail(r, body)}
	meta := requestMetadata(body, r)
	clientRequestedModel := meta.Model
	resolved := resolveAPIKeyModel(resolveClaudeCatalogModel(meta.Model), key.ModelAliases)
	resolved.RequestedModel = clientRequestedModel
	resolved.Stream = meta.Stream
	resolved.ServiceTier = meta.ServiceTier
	resolved.ReasoningEffort = meta.ReasoningEffort
	meta = resolved
	body, err = rewriteRequestModel(body, r.URL, meta.RequestedModel, meta.Model)
	if err != nil {
		const message = "无法改写请求模型"
		writeError(w, http.StatusBadRequest, "invalid_request", message)
		detail := rejectedRequestDetail(r, body, true, "invalid_request", message, started)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusBadRequest, started, "invalid_request", message, detail)
		return
	}
	websocket := isWebSocketUpgrade(r)
	billable := meta.Model != "" && (websocket || (r.Method != http.MethodGet && r.Method != http.MethodHead))
	if meta.Model != "" && !allowed(meta.Model, key.ModelAllowlist, key.TenantModels) {
		const message = "该 API Key 无权使用此模型"
		writeError(w, http.StatusForbidden, "model_not_allowed", message)
		detail := rejectedRequestDetail(r, body, true, "model_not_allowed", message, started)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusForbidden, started, "model_not_allowed", message, detail)
		return
	}
	if err := a.enforceLimits(r.Context(), key); err != nil {
		message := boundedErrorText(err.Error())
		writeError(w, http.StatusTooManyRequests, "quota_exceeded", message)
		detail := rejectedRequestDetail(r, body, true, "quota_exceeded", message, started)
		a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusTooManyRequests, started, "quota_exceeded", message, detail)
		return
	}
	limitsCheckedAt := time.Now()

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
				const message = "模型尚未配置价格"
				writeError(w, http.StatusBadRequest, "price_not_configured", message)
				detail := rejectedRequestDetail(r, body, true, "price_not_configured", message, started)
				a.writeRejectedRequestLog(key, requestID, admission, meta, r, http.StatusBadRequest, started, "price_not_configured", message, detail)
				return
			}
		} else {
			priceConfigured = true
		}
		priceSnapshot = store.EncodePriceSnapshot(price)
		reserve := int64(0)
		if priceConfigured {
			reserve = a.cfg.ReservationNanoUSD
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
			status, code, message := http.StatusPaymentRequired, "admission_failed", "余额不足或订阅不可用"
			switch {
			case errors.Is(err, store.ErrSubscriptionPrice):
				status, code, message = http.StatusBadRequest, "price_not_configured", "计量子订阅要求先配置模型价格"
			case errors.Is(err, store.ErrSubscriptionRequired):
				status, code, message = http.StatusForbidden, "subscription_not_available", "没有可用于该模型的子订阅"
			case errors.Is(err, store.ErrSubscriptionExhausted):
				status, code, message = http.StatusTooManyRequests, "subscription_quota_exceeded", "所有可用子订阅额度均已耗尽"
			}
			writeError(w, status, code, message)
			detail := rejectedRequestDetail(r, body, true, code, message, started)
			a.writeRejectedRequestLog(key, requestID, admission, meta, r, status, started, code, message, detail)
			return
		}
		if priceConfigured {
			if resolved, resolveErr := a.store.ResolvePrice(r.Context(), pricing.Dimensions{
				APIGroupKey: key.ID, Model: meta.Model, AuthIndex: admission.CPAAuthIndex,
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

	if websocket {
		r.Body = io.NopCloser(bytes.NewReader(body))
		a.proxyNativeWebSocket(w, r, key, requestID, admission, meta, started, billable, logContext)
		return
	}

	upstreamStartedAt := time.Now()
	var response *http.Response
	target := targetCPA.URL(r.URL.RequestURI())
	var upstream *http.Request
	upstream, err = http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err == nil {
		copyHeaders(upstream.Header, r.Header)
		upstream.Header.Set("Authorization", "Bearer "+targetCPA.APIKey)
		upstream.Header.Del("X-API-Key")
		upstream.Header.Del("X-Goog-API-Key")
		upstream.Header.Set("X-Relay-Request-ID", requestID)
		if admission.CPAAuthID != "" {
			upstream.Header.Set("X-Relay-CPA-Auth-ID", admission.CPAAuthID)
		}
		upstream.Host = targetCPA.BaseURL.Host
		logContext.detail.ForwardedHeaders = sanitizedHeaders(upstream.Header)
		logContext.detail.ForwardedBody, logContext.detail.ForwardedBodyTruncated, logContext.detail.ForwardedBodyBytes = boundedDetail(body)
		response, err = targetCPA.HTTP.Do(upstream)
	}
	if err != nil {
		if r.Context().Err() == nil {
			targetCPA.RecordTransportResult(err)
		}
		a.releaseReservation(requestID, billable)
		classified := classifyCPATransportError(err, r.Context().Err(), "awaiting_headers")
		logContext.errorCode = classified.Code
		logContext.detail.ErrorName = "upstream_error"
		logContext.detail.ErrorMessage = err.Error()
		logContext.detail.StageTimings = timingJSON(map[string]int64{
			"read_body_ms": bodyReadAt.Sub(started).Milliseconds(), "total_ms": time.Since(started).Milliseconds(),
		})
		a.writeRequestLog(key, requestID, admission, meta, r, 0, started, nil, false, true, 0, err.Error(), logContext)
		writeCPATransportError(w, r, err, "awaiting_headers", requestID)
		return
	}
	targetCPA.RecordTransportResult(nil)
	upstreamHeadersAt := time.Now()
	defer response.Body.Close()
	copyHeaders(w.Header(), response.Header)
	setStreamingHeaders(w.Header(), meta.Stream)
	w.Header().Set("X-Relay-Request-ID", requestID)
	if admission.ChildSubscriptionID != "" {
		w.Header().Set("X-Relay-Subscription-ID", admission.ChildSubscriptionID)
	}
	w.WriteHeader(response.StatusCode)
	if meta.Stream {
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}
	capture := &rollingCapture{max: 2 << 20}
	var firstByteAt time.Time
	firstByte := func() {
		if firstByteAt.IsZero() {
			firstByteAt = time.Now()
		}
	}
	var copyErr error
	copyErr = copyStreaming(w, io.TeeReader(response.Body, capture), firstByte)
	if isUpstreamStreamError(copyErr) && r.Context().Err() == nil {
		targetCPA.RecordTransportResult(copyErr)
	}

	parsed := billing.ParseResponse(capture.Bytes())
	if priceConfigured && parsed.ResponseServiceTier != "" {
		if resolved, resolveErr := a.store.ResolvePrice(r.Context(), pricing.Dimensions{
			APIGroupKey: key.ID, Model: meta.Model, AuthIndex: admission.CPAAuthIndex,
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
	if billable && response.StatusCode < http.StatusBadRequest && parsed.Found && priceConfigured {
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
	if copyErr != nil {
		errorMessage = copyErr.Error()
		logContext.errorCode = "stream_copy_error"
	}
	rawResponse, responseTruncated, responseBytes := capture.Info()
	logContext.cpaTraceID = strings.TrimSpace(response.Header.Get("X-CPA-TRACE-ID"))
	logContext.detail.UpstreamStatus = response.StatusCode
	logContext.detail.UpstreamHeaders = sanitizedHeaders(response.Header)
	logContext.detail.UpstreamBody, _, _ = boundedDetail(rawResponse)
	logContext.detail.UpstreamBodyTruncated = responseTruncated || responseBytes > requestLogDetailLimit
	logContext.detail.UpstreamBodyBytes = responseBytes
	if !firstByteAt.IsZero() {
		ttft := firstByteAt.Sub(started).Milliseconds()
		logContext.ttftMS = &ttft
	}
	logContext.detail.StageTimings = timingJSON(map[string]int64{
		"resolve_key_ms":      keyResolvedAt.Sub(started).Milliseconds(),
		"read_body_ms":        bodyReadAt.Sub(keyResolvedAt).Milliseconds(),
		"limits_ms":           limitsCheckedAt.Sub(bodyReadAt).Milliseconds(),
		"admission_ms":        admittedAt.Sub(limitsCheckedAt).Milliseconds(),
		"upstream_start_ms":   upstreamStartedAt.Sub(started).Milliseconds(),
		"upstream_wait_ms":    upstreamHeadersAt.Sub(upstreamStartedAt).Milliseconds(),
		"upstream_headers_ms": upstreamHeadersAt.Sub(started).Milliseconds(),
		"first_byte_ms":       valueOrZero(logContext.ttftMS),
		"total_ms":            time.Since(started).Milliseconds(),
	})
	if response.StatusCode >= http.StatusBadRequest && logContext.errorCode == "" {
		logContext.errorCode = "upstream_http_error"
		logContext.detail.ErrorName = logContext.errorCode
		logContext.detail.ErrorDetail = logContext.detail.UpstreamBody
		errorMessage = upstreamErrorMessage(response.StatusCode, rawResponse)
	}
	if copyErr != nil {
		logContext.detail.ErrorName = "stream_copy_error"
		logContext.detail.ErrorMessage = copyErr.Error()
	}
	a.writeRequestLog(key, requestID, admission, meta, r, response.StatusCode, started, &parsed, cost != nil, settled, actual, errorMessage, logContext)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func resolveClaudeCatalogModel(model string) string {
	const prefix = "claude-fable-5-dd-"
	model = strings.TrimSpace(model)
	base, suffix := model, ""
	if open := strings.LastIndex(model, "("); open > 0 && strings.HasSuffix(model, ")") {
		base = model[:open]
		suffix = model[open:]
	}
	if !strings.HasPrefix(strings.ToLower(base), prefix) {
		return model
	}
	encoded := base[len(prefix):]
	if encoded == "" {
		return model
	}
	return reverseString(encoded) + suffix
}

func (a *App) writeRequestLog(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, r *http.Request, status int,
	started time.Time, parsed *billing.Result, pricingComplete, settled bool, cost int64, errorMessage string, logContext requestLogContext) {
	usage := store.Usage{}
	cpaID := ""
	if parsed != nil {
		usage = parsed.Usage
		cpaID = parsed.RequestID
	}
	var costPointer *int64
	if pricingComplete {
		costPointer = &cost
	}
	detail := logContext.detail
	if status > 0 && status < http.StatusBadRequest && pricingComplete && !sampledRequest(requestID, a.cfg.RequestSuccessSamplePPM) {
		detail = nil
	}
	err := a.store.WriteLog(context.WithoutCancel(r.Context()), store.LogInput{
		ID: requestID, TenantID: key.TenantID, APIKeyID: key.ID, CPARequestID: cpaID, Model: meta.Model,
		CPATraceID: logContext.cpaTraceID, RequestedModel: meta.RequestedModel, ActualModel: meta.Model, ModelAlias: meta.ModelAlias, TenantName: key.TenantName,
		APIKeyName: key.Name, APIKeyPrefix: key.Prefix, RequestType: requestType(r.URL.Path, isWebSocketUpgrade(r)),
		ServiceTier: meta.ServiceTier, ResponseServiceTier: parsedResponseServiceTier(parsed), ReasoningEffort: meta.ReasoningEffort,
		AuthIndex: admission.CPAAuthIndex, ParentSubscriptionID: admission.ParentSubscriptionID,
		ChildSubscriptionID: admission.ChildSubscriptionID,
		Method:              r.Method, Path: r.URL.Path, StatusCode: status, Stream: meta.Stream, Usage: usage,
		CostNanoUSD: costPointer, Price: logContext.price, PricingComplete: pricingComplete, Settled: settled,
		ReservedNanoUSD: max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD), LatencyMS: time.Since(started).Milliseconds(),
		TTFTMS: logContext.ttftMS, ErrorCode: logContext.errorCode, ErrorMessage: errorMessage,
		StartedAt: started, CompletedAt: time.Now(), Detail: detail,
	})
	if err != nil {
		slog.Error("write request log", "request_id", requestID, "error", err)
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

func writeCPAAdmissionError(w http.ResponseWriter, err error, status cpa.AdmissionStatus) cpaTransportError {
	retryAfter := int64(1)
	httpStatus := http.StatusServiceUnavailable
	retryable := true
	code := "cpa_overloaded"
	message := "CPA 当前并发已达到安全上限，请稍后重试"
	switch {
	case errors.Is(err, context.Canceled):
		httpStatus = 499
		retryable = false
		code = "client_canceled"
		message = "请求已由客户端取消"
	case errors.Is(err, context.DeadlineExceeded):
		httpStatus = http.StatusGatewayTimeout
		code = "request_timeout"
		message = "请求在等待 CPA 准入时超时"
	case errors.Is(err, cpa.ErrCircuitOpen):
		code = "cpa_circuit_open"
		message = "CPA 正在从连续故障中恢复，请稍后重试"
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
	return cpaTransportError{Status: httpStatus, Code: code, Message: message, Phase: "admission", Retryable: retryable}
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

func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func (a *App) enforceLimits(ctx context.Context, key store.KeyContext) error {
	if key.TenantTokenLimit != nil || key.TokenLimitDaily != nil {
		tenantTokens, keyTokens, err := a.store.DailyTokens(ctx, key.TenantID, key.ID)
		if err != nil {
			return err
		}
		if key.TenantTokenLimit != nil && tenantTokens >= *key.TenantTokenLimit {
			return errors.New("租户今日 Token 额度已用尽")
		}
		if key.TokenLimitDaily != nil && keyTokens >= *key.TokenLimitDaily {
			return errors.New("API Key 今日 Token 额度已用尽")
		}
	}
	// Per-minute admission is intentionally process-local; PostgreSQL remains the source of truth for billing.
	limit := key.RateLimitPerMinute
	if limit == nil {
		limit = key.TenantRateLimit
	}
	if limit != nil && !a.allowRate(key.ID, *limit) {
		return errors.New("每分钟请求次数超限")
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
