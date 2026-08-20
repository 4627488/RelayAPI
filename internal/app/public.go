package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

type priceLookupResult struct {
	price store.ResolvedPrice
	err   error
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
	if expectedBodyBytes < 0 || expectedBodyBytes > a.maxRequestBytes() {
		expectedBodyBytes = a.maxRequestBytes()
	}
	targetAdmission := a.admission()
	if targetAdmission == nil || a.nativeRuntime == nil || a.inferenceCPA() == nil {
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

	body, err := readBoundedRequestBody(w, r, a.maxRequestBytes())
	if err != nil {
		a.rejectPublic(w, r, key, requestID, admission, requestMetadata(body, r), body, started, timeline,
			publicError(http.StatusRequestEntityTooLarge, "body_too_large", fmt.Sprintf("请求体超过 %d MiB", a.maxRequestBytes()>>20)))
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
			if a.unpricedModelPolicy() == "deny" {
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
		reservationTTL := maxDuration(30*time.Minute, a.requestTimeout()+5*time.Minute)
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

func retiredProtocolPath(path string) bool {
	path = strings.TrimRight(strings.TrimSpace(path), "/")
	return path == "/v1/messages" || path == "/v1/messages/count_tokens" || strings.HasPrefix(path, "/v1beta/")
}

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
