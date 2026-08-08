package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

type nativeWebSocketAccounting struct {
	admission store.Admission
	price     *store.ResolvedPrice
	billable  bool
	result    billing.Result
	errorCode string
	errorHTTP int
}

func (a *App) proxyNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string,
	admission store.Admission, meta requestMeta, started time.Time, billable bool, logContext requestLogContext) {
	accounting := nativeWebSocketAccounting{admission: admission, price: logContext.price, billable: billable}
	connected, resolvedMeta, err := a.serveNativeWebSocket(w, r, key, meta, requestID, logContext.detail, &accounting)
	if resolvedMeta.Model != "" {
		meta = resolvedMeta
	}
	admission = accounting.admission
	billable = accounting.billable
	logContext.price = accounting.price
	statusCode := http.StatusSwitchingProtocols
	if !connected {
		statusCode = accounting.errorHTTP
		if statusCode == 0 {
			statusCode = http.StatusBadGateway
		}
		logContext.errorCode = accounting.errorCode
		if logContext.errorCode == "" {
			logContext.errorCode = "websocket_proxy_error"
		}
	}
	if accounting.price != nil && accounting.result.ResponseServiceTier != "" {
		if resolved, resolveErr := a.store.ResolvePrice(context.Background(), pricing.Dimensions{
			APIGroupKey: key.ID, Model: meta.Model, AuthIndex: admission.CPAAuthIndex,
			ServiceTier: meta.ServiceTier, ResponseServiceTier: accounting.result.ResponseServiceTier,
			ReasoningEffort: meta.ReasoningEffort, Endpoint: r.URL.Path,
		}); resolveErr == nil {
			accounting.price = &resolved
			logContext.price = &resolved
			_ = a.store.UpdateReservationPriceSnapshot(context.Background(), requestID, store.EncodePriceSnapshot(resolved))
		}
	}
	pricingComplete := billable && accounting.result.Found && accounting.price != nil
	actual := max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
	settled := !billable
	if billable {
		var settleErr error
		if connected {
			if pricingComplete {
				actual = billing.Cost(*accounting.price, accounting.result.Usage)
			}
			settleErr = a.store.SettleRequestReservation(context.Background(), requestID, actual, pricingComplete)
		} else {
			actual = 0
			settleErr = a.store.ReleaseRequestReservation(context.Background(), requestID)
		}
		if settleErr == nil {
			settled = true
		} else {
			slog.Error("settle native websocket request", "request_id", requestID, "error", settleErr)
		}
	}
	if err != nil && !normalWebSocketClose(err) {
		slog.Warn("native websocket proxy", "request_id", requestID, "error", err)
		if connected {
			logContext.errorCode = "websocket_session_error"
		}
		logContext.detail.ErrorName = logContext.errorCode
		logContext.detail.ErrorMessage = boundedErrorText(err.Error())
	}
	duration := time.Since(started).Milliseconds()
	logContext.detail.StageTimings = timingJSON(map[string]int64{"websocket_duration_ms": duration, "total_ms": duration})
	a.writeRequestLog(key, requestID, admission, meta, r, statusCode, started, &accounting.result, pricingComplete, settled, actual, errorString(err), logContext)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

// serveNativeWebSocket is a billing-aware gateway in front of the embedded CPA
// server. Relay only inspects the first request for admission and terminal
// response events for usage; all protocol behavior remains owned by CPA's
// complete Responses WebSocket handler.
func (a *App) serveNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext,
	meta requestMeta, requestID string, logDetail *store.LogDetailInput, accounting *nativeWebSocketAccounting) (bool, requestMeta, error) {
	upgrader := websocket.Upgrader{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
		Subprotocols:      websocket.Subprotocols(r),
		CheckOrigin:       func(*http.Request) bool { return true },
	}
	downstream, err := upgrader.Upgrade(w, r, http.Header{"X-Relay-Request-ID": []string{requestID}})
	if err != nil {
		return false, meta, err
	}
	defer downstream.Close()
	downstream.SetReadLimit(a.cfg.CPAMaxRequestBytes)
	_ = downstream.SetReadDeadline(time.Now().Add(30 * time.Second))
	messageType, firstFrame, err := downstream.ReadMessage()
	_ = downstream.SetReadDeadline(time.Time{})
	if err != nil {
		return false, meta, err
	}
	if (messageType != websocket.TextMessage && messageType != websocket.BinaryMessage) || !json.Valid(firstFrame) {
		err = fmt.Errorf("first websocket message must be a JSON response.create frame")
		accounting.errorHTTP, accounting.errorCode = http.StatusBadRequest, "invalid_request"
		writeNativeWebSocketError(downstream, "invalid_request", err.Error())
		return false, meta, err
	}
	captureWebSocketRequest(logDetail, firstFrame)
	frameMeta := readRequestMeta(firstFrame, r.URL.Path)
	if meta.Model == "" {
		resolved := resolveAPIKeyModel(frameMeta.Model, key.ModelAliases)
		resolved.RequestedModel = frameMeta.Model
		resolved.Stream = true
		resolved.ServiceTier = frameMeta.ServiceTier
		resolved.ReasoningEffort = frameMeta.ReasoningEffort
		meta = resolved
	}
	if meta.Model == "" {
		err = fmt.Errorf("response.create requires model")
		accounting.errorHTTP, accounting.errorCode = http.StatusBadRequest, "model_required"
		writeNativeWebSocketError(downstream, "model_required", err.Error())
		return false, meta, err
	}
	if !allowed(meta.Model, key.ModelAllowlist, key.TenantModels) {
		err = fmt.Errorf("API key is not allowed to use model %q", meta.Model)
		accounting.errorHTTP, accounting.errorCode = http.StatusForbidden, "model_not_allowed"
		writeNativeWebSocketError(downstream, "model_not_allowed", err.Error())
		return false, meta, err
	}
	if !accounting.billable {
		admission, price, code, admitErr := a.admitNativeWebSocket(r.Context(), key, meta, requestID, r.URL.Path)
		if admitErr != nil {
			accounting.errorHTTP, accounting.errorCode = nativeWebSocketAdmissionError(code)
			writeNativeWebSocketError(downstream, code, admitErr.Error())
			return false, meta, admitErr
		}
		accounting.admission = admission
		accounting.price = price
		accounting.billable = true
	}
	if a.nativeCPARuntime != nil {
		upstreamModel := a.nativeCPARuntime.ResolveCredentialModel(accounting.admission.CPAAuthID, meta.Model)
		if upstreamModel != "" && upstreamModel != frameMeta.Model {
			firstFrame, err = rewriteRequestModel(firstFrame, r.URL, frameMeta.Model, upstreamModel)
			if err != nil {
				writeNativeWebSocketError(downstream, "invalid_request", "unable to resolve websocket model")
				return false, meta, err
			}
		}
	}

	upstream, response, err := a.dialEmbeddedCPAWebSocket(r.Context(), r, accounting.admission, requestID)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		writeNativeWebSocketError(downstream, "embedded_cpa_unavailable", err.Error())
		return false, meta, err
	}
	defer upstream.Close()
	upstream.SetReadLimit(a.cfg.CPAMaxRequestBytes)
	if err = upstream.WriteMessage(messageType, firstFrame); err != nil {
		return false, meta, err
	}

	stopCancel := context.AfterFunc(r.Context(), func() {
		_ = downstream.Close()
		_ = upstream.Close()
	})
	defer stopCancel()
	type pumpResult struct {
		err error
	}
	results := make(chan pumpResult, 2)
	go func() {
		results <- pumpResult{err: pumpWebSocketMessages(downstream, upstream, nil)}
	}()
	go func() {
		results <- pumpResult{err: pumpWebSocketMessages(upstream, downstream, func(payload []byte) {
			mergeNativeWebSocketResult(&accounting.result, parseNativeWebSocketUsage(payload))
		})}
	}()

	first := <-results
	_ = downstream.Close()
	_ = upstream.Close()
	<-results
	return true, meta, first.err
}

func nativeWebSocketAdmissionError(code string) (int, string) {
	switch code {
	case "price_not_configured":
		return http.StatusBadRequest, code
	case "subscription_not_available", "model_not_allowed":
		return http.StatusForbidden, code
	case "subscription_quota_exceeded":
		return http.StatusTooManyRequests, code
	default:
		return http.StatusPaymentRequired, firstNonEmptyString(code, "admission_failed")
	}
}

func (a *App) dialEmbeddedCPAWebSocket(ctx context.Context, r *http.Request, admission store.Admission, requestID string) (
	*websocket.Conn, *http.Response, error) {
	if a.nativeCPA == nil || a.nativeCPA.BaseURL == nil {
		return nil, nil, fmt.Errorf("embedded CPA runtime is not available")
	}
	target, err := url.Parse(a.nativeCPA.URL(embeddedCPAWebSocketPath(r.URL)))
	if err != nil {
		return nil, nil, err
	}
	switch target.Scheme {
	case "http":
		target.Scheme = "ws"
	case "https":
		target.Scheme = "wss"
	default:
		return nil, nil, fmt.Errorf("embedded CPA URL uses unsupported scheme %q", target.Scheme)
	}
	header := embeddedCPAWebSocketHeaders(r.Header)
	header.Set("Authorization", "Bearer "+a.nativeCPA.APIKey)
	header.Set("X-Relay-Request-ID", requestID)
	if admission.CPAAuthID != "" {
		header.Set("X-Relay-CPA-Auth-ID", admission.CPAAuthID)
	}
	dialer := websocket.Dialer{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
		Subprotocols:      websocket.Subprotocols(r),
	}
	return dialer.DialContext(ctx, target.String(), header)
}

func embeddedCPAWebSocketPath(requestURL *url.URL) string {
	if requestURL == nil {
		return "/v1/responses"
	}
	path := requestURL.RequestURI()
	if strings.HasSuffix(strings.TrimSuffix(requestURL.Path, "/"), "/responses/ws") {
		copyURL := *requestURL
		copyURL.Path = strings.TrimSuffix(strings.TrimSuffix(requestURL.Path, "/"), "/ws")
		copyURL.RawPath = ""
		path = copyURL.RequestURI()
	}
	return path
}

func embeddedCPAWebSocketHeaders(source http.Header) http.Header {
	header := source.Clone()
	stripRelayHeaders(header)
	for _, name := range []string{
		"Authorization", "Connection", "Upgrade", "Sec-WebSocket-Key", "Sec-WebSocket-Version",
		"Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol",
	} {
		header.Del(name)
	}
	return header
}

func pumpWebSocketMessages(source, destination *websocket.Conn, observe func([]byte)) error {
	for {
		messageType, payload, err := source.ReadMessage()
		if err != nil {
			forwardWebSocketClose(destination, err)
			return err
		}
		if observe != nil {
			observe(payload)
		}
		if err = destination.WriteMessage(messageType, payload); err != nil {
			return err
		}
	}
}

func forwardWebSocketClose(destination *websocket.Conn, sourceErr error) {
	code := websocket.CloseInternalServerErr
	message := boundedErrorText(sourceErr.Error())
	var closeErr *websocket.CloseError
	if errors.As(sourceErr, &closeErr) {
		code = closeErr.Code
		message = closeErr.Text
	} else if normalWebSocketClose(sourceErr) {
		code = websocket.CloseNormalClosure
		message = ""
	}
	// 1005, 1006 and 1015 are receive-only sentinel values and cannot appear
	// in a close frame. Translate them before relaying an abnormal disconnect.
	if code == websocket.CloseNoStatusReceived || code == websocket.CloseAbnormalClosure || code == websocket.CloseTLSHandshake {
		code = websocket.CloseInternalServerErr
	}
	message = websocketCloseReason(message)
	_ = destination.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, message), time.Now().Add(time.Second))
}

func websocketCloseReason(message string) string {
	const maxBytes = 123
	if len(message) <= maxBytes {
		return message
	}
	for len(message) > maxBytes || !utf8.ValidString(message) {
		message = message[:len(message)-1]
	}
	return message
}

func parseNativeWebSocketUsage(payload []byte) billing.Result {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return billing.Result{}
	}
	switch event.Type {
	case "response.completed", "response.incomplete", "response.done":
		return billing.ParseResponse(payload)
	default:
		return billing.Result{}
	}
}

func (a *App) admitNativeWebSocket(ctx context.Context, key store.KeyContext, meta requestMeta, requestID, endpoint string) (
	store.Admission, *store.ResolvedPrice, string, error) {
	dimensions := pricing.Dimensions{APIGroupKey: key.ID, Model: meta.Model, ServiceTier: meta.ServiceTier,
		ReasoningEffort: meta.ReasoningEffort, Endpoint: endpoint}
	price, priceErr := a.store.ResolvePrice(ctx, dimensions)
	priceConfigured := priceErr == nil
	if !priceConfigured && a.cfg.UnpricedModelPolicy == "deny" {
		return store.Admission{}, nil, "price_not_configured", fmt.Errorf("模型尚未配置价格")
	}
	reserve := int64(0)
	if priceConfigured {
		reserve = a.cfg.ReservationNanoUSD
	}
	admission, err := a.store.AdmitRequest(ctx, store.AdmissionInput{
		RequestID: requestID, Key: key, Model: meta.Model,
		BalanceReserve: reserve, QuotaReserve: reserve, PriceConfigured: priceConfigured,
		PriceSnapshot: store.EncodePriceSnapshot(price), ExpiresAt: time.Now().Add(24 * time.Hour),
	})
	if err != nil {
		code, message := "admission_failed", "余额不足或订阅不可用"
		switch {
		case errors.Is(err, store.ErrSubscriptionPrice):
			code, message = "price_not_configured", "计量子订阅要求先配置模型价格"
		case errors.Is(err, store.ErrSubscriptionRequired):
			code, message = "subscription_not_available", "没有可用于该模型的子订阅"
		case errors.Is(err, store.ErrSubscriptionExhausted):
			code, message = "subscription_quota_exceeded", "所有可用子订阅额度均已耗尽"
		}
		return store.Admission{}, nil, code, fmt.Errorf("%s", message)
	}
	if !priceConfigured {
		return admission, nil, "", nil
	}
	dimensions.AuthIndex = admission.CPAAuthIndex
	if resolved, resolveErr := a.store.ResolvePrice(ctx, dimensions); resolveErr == nil {
		resolvedSnapshot := store.EncodePriceSnapshot(resolved)
		if !bytes.Equal(resolvedSnapshot, store.EncodePriceSnapshot(price)) {
			_ = a.store.UpdateReservationPriceSnapshot(ctx, requestID, resolvedSnapshot)
		}
		price = resolved
	}
	return admission, &price, "", nil
}

func mergeNativeWebSocketResult(target *billing.Result, turn billing.Result) {
	if turn.RequestID != "" {
		target.RequestID = turn.RequestID
	}
	if turn.ResponseServiceTier != "" {
		target.ResponseServiceTier = turn.ResponseServiceTier
	}
	target.Found = target.Found || turn.Found
	target.Usage.Prompt = saturatingAdd(target.Usage.Prompt, turn.Usage.Prompt)
	target.Usage.Completion = saturatingAdd(target.Usage.Completion, turn.Usage.Completion)
	target.Usage.Cached = saturatingAdd(target.Usage.Cached, turn.Usage.Cached)
	target.Usage.CacheWrite = saturatingAdd(target.Usage.CacheWrite, turn.Usage.CacheWrite)
	target.Usage.Reasoning = saturatingAdd(target.Usage.Reasoning, turn.Usage.Reasoning)
	target.Usage.Total = saturatingAdd(target.Usage.Total, turn.Usage.Total)
}

func saturatingAdd(left, right int64) int64 {
	if right > 0 && left > math.MaxInt64-right {
		return math.MaxInt64
	}
	return left + right
}

func writeNativeWebSocketError(conn *websocket.Conn, code, message string) {
	payload, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "invalid_request_error", "code": code, "message": message}})
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}

func normalWebSocketClose(err error) bool {
	return err == nil || errors.Is(err, context.Canceled) || websocket.IsCloseError(err,
		websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived)
}

func errorString(err error) string {
	if err == nil || normalWebSocketClose(err) {
		return ""
	}
	return err.Error()
}
