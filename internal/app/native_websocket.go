package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

type nativeWebSocketAccounting struct {
	mu               sync.Mutex
	admission        store.Admission
	price            *store.ResolvedPrice
	billable         bool
	result           billing.Result
	errorCode        string
	errorHTTP        int
	requestBytes     int64
	forwardedBytes   int64
	responseBytes    int64
	terminalSeen     bool
	turnsSeen        int64
	accruedNanoUSD   int64
	pricingComplete  bool
	currentMeta      requestMeta
	currentStarted   time.Time
	currentRequest   int64
	currentForwarded int64
	currentResponse  int64
	persistTurn      func(nativeWebSocketBillingEntry, billing.Result) (bool, error)
}

type nativeWebSocketBillingEntry struct {
	Meta           requestMeta
	Result         billing.Result
	Payload        []byte
	StartedAt      time.Time
	RequestBytes   int64
	ForwardedBytes int64
	ResponseBytes  int64
}

type nativeWebSocketSessionState struct {
	upgraded    bool
	established bool
}

const nativeWebSocketHeartbeatInterval = 30 * time.Second

func (a *App) proxyNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string,
	admission store.Admission, meta requestMeta, started time.Time, billable bool, logContext requestLogContext) {
	accounting := nativeWebSocketAccounting{admission: admission, price: logContext.price, billable: billable}
	accounting.persistTurn = func(entry nativeWebSocketBillingEntry, cumulative billing.Result) (bool, error) {
		return a.persistNativeWebSocketTurn(context.WithoutCancel(r.Context()), r, key, requestID,
			logContext, &accounting, entry, cumulative)
	}
	session, resolvedMeta, err := a.serveNativeWebSocket(w, r, key, meta, requestID, logContext.detail, &accounting)
	if resolvedMeta.Model != "" {
		meta = resolvedMeta
	}
	admission = accounting.admission
	billable = accounting.billable
	logContext.price = accounting.price
	statusCode := http.StatusSwitchingProtocols
	if accounting.errorHTTP != 0 {
		statusCode = accounting.errorHTTP
		logContext.errorCode = accounting.errorCode
		if logContext.errorCode == "" {
			logContext.errorCode = "websocket_proxy_error"
		}
	} else if err != nil && !session.established {
		statusCode = http.StatusBadGateway
		logContext.errorCode = firstNonEmptyString(accounting.errorCode, "websocket_proxy_error")
	} else if !session.upgraded {
		statusCode = http.StatusBadGateway
		logContext.errorCode = "websocket_proxy_error"
	}
	if accounting.turnsSeen == 0 && accounting.price != nil && accounting.result.ResponseServiceTier != "" {
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
	pricingComplete := billable && accounting.turnsSeen > 0 && accounting.pricingComplete
	actual := max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
	if accounting.turnsSeen > 0 {
		actual = accounting.accruedNanoUSD
	}
	settled := !billable
	if billable {
		var settleErr error
		if session.established {
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
		if session.established {
			logContext.errorCode = "websocket_session_error"
		}
		logContext.detail.ErrorName = logContext.errorCode
		logContext.detail.ErrorMessage = boundedErrorText(err.Error())
	}
	duration := time.Since(started).Milliseconds()
	logContext.requestBytes = accounting.requestBytes
	logContext.forwardedBytes = accounting.forwardedBytes
	logContext.responseBytes = accounting.responseBytes
	logContext.detail.StageTimings = timingJSON(map[string]int64{"websocket_duration_ms": duration, "total_ms": duration})
	// Successful terminal responses already produced one durable log per billing
	// entry. Only sessions without a billing entry need a session-level log.
	if accounting.turnsSeen == 0 {
		input := requestLogInput(key, requestID, admission, meta, r, statusCode, started, &accounting.result,
			pricingComplete, settled, actual, errorString(err), logContext)
		if !shouldRetainRequestDetail(requestID, statusCode, logContext.errorCode, a.cfg.RequestSuccessSamplePPM) {
			input.Detail = nil
		}
		if logErr := a.store.UpsertLog(context.WithoutCancel(r.Context()), input); logErr != nil {
			slog.Error("upsert native websocket request log", "request_id", requestID, "error", logErr)
		}
	}
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) persistNativeWebSocketTurn(ctx context.Context, r *http.Request, key store.KeyContext, requestID string,
	logContext requestLogContext, accounting *nativeWebSocketAccounting,
	entry nativeWebSocketBillingEntry, cumulative billing.Result) (bool, error) {
	turn, meta := entry.Result, entry.Meta
	var turnPrice *store.ResolvedPrice
	if resolved, err := a.store.ResolvePrice(ctx, pricing.Dimensions{
		APIGroupKey: key.ID, Model: meta.Model, AuthIndex: accounting.admission.CPAAuthIndex,
		ServiceTier: meta.ServiceTier, ResponseServiceTier: turn.ResponseServiceTier,
		ReasoningEffort: meta.ReasoningEffort, Endpoint: r.URL.Path,
	}); err == nil {
		turnPrice = &resolved
	}
	turnComplete := accounting.billable && turn.Found && turnPrice != nil && billing.UsageComplete(*turnPrice, turn.Usage)
	turnCost := int64(0)
	if accounting.billable {
		turnCost = max64(accounting.admission.BalanceReservedNanoUSD, accounting.admission.QuotaReservedNanoUSD)
		if turnComplete {
			turnCost = billing.Cost(*turnPrice, turn.Usage)
		}
	}
	aggregateComplete := turnComplete
	if accounting.turnsSeen > 0 {
		aggregateComplete = accounting.pricingComplete && turnComplete
	}
	aggregateCost := saturatingAdd(accounting.accruedNanoUSD, turnCost)
	turnID := strings.TrimSpace(turn.RequestID)
	if turnID == "" {
		turnID = fmt.Sprintf("sha256:%x", sha256.Sum256(entry.Payload))
	}
	logContext.price = turnPrice
	logContext.requestBytes = entry.RequestBytes
	logContext.forwardedBytes = entry.ForwardedBytes
	logContext.responseBytes = entry.ResponseBytes
	duration := time.Since(entry.StartedAt).Milliseconds()
	logID := requestID
	if accounting.turnsSeen > 0 {
		logID = identity.NewID()
		logContext.detail = nil
	} else if !shouldRetainRequestDetail(logID, http.StatusSwitchingProtocols, "", a.cfg.RequestSuccessSamplePPM) {
		logContext.detail = nil
	} else if logContext.detail != nil {
		detail := *logContext.detail
		detail.StageTimings = timingJSON(map[string]int64{"websocket_turn_ms": duration, "total_ms": duration})
		logContext.detail = &detail
	}
	input := requestLogInput(key, logID, accounting.admission, meta, r, http.StatusSwitchingProtocols,
		entry.StartedAt, &turn, turnComplete, true, turnCost, "", logContext)
	input.ReservationRequestID = requestID
	input.LatencyMS = duration
	input.CompletedAt = time.Now()
	inserted, err := a.store.AccrueWebSocketTurn(ctx, store.WebSocketTurnAccrual{
		RequestID: requestID, TurnID: turnID, Usage: turn.Usage, CostNanoUSD: turnCost,
		PricingComplete: turnComplete, Log: input,
	})
	if err != nil || !inserted {
		return inserted, err
	}
	accounting.turnsSeen++
	accounting.accruedNanoUSD = aggregateCost
	accounting.pricingComplete = aggregateComplete
	accounting.price = turnPrice
	return true, nil
}

// serveNativeWebSocket is a billing-aware gateway in front of the embedded CPA
// server. Relay only inspects the first request for admission and terminal
// response events for usage; all protocol behavior remains owned by CPA's
// complete Responses WebSocket handler.
func (a *App) serveNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext,
	meta requestMeta, requestID string, logDetail *store.LogDetailInput, accounting *nativeWebSocketAccounting) (nativeWebSocketSessionState, requestMeta, error) {
	var session nativeWebSocketSessionState
	upgrader := websocket.Upgrader{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
		Subprotocols:      websocket.Subprotocols(r),
		CheckOrigin:       func(*http.Request) bool { return true },
	}
	downstream, err := upgrader.Upgrade(w, r, http.Header{"X-Relay-Request-ID": []string{requestID}})
	if err != nil {
		return session, meta, err
	}
	session.upgraded = true
	defer downstream.Close()
	downstream.SetReadLimit(a.cfg.CPAMaxRequestBytes)
	_ = downstream.SetReadDeadline(time.Now().Add(30 * time.Second))
	messageType, firstFrame, err := downstream.ReadMessage()
	_ = downstream.SetReadDeadline(time.Time{})
	if err != nil {
		if clientWebSocketDisconnect(err) {
			return session, meta, nil
		}
		return session, meta, err
	}
	if (messageType != websocket.TextMessage && messageType != websocket.BinaryMessage) || !json.Valid(firstFrame) {
		err = fmt.Errorf("first websocket message must be a JSON response.create frame")
		accounting.errorHTTP, accounting.errorCode = http.StatusBadRequest, "invalid_request"
		writeNativeWebSocketError(downstream, http.StatusBadRequest, "invalid_request", err.Error())
		return session, meta, err
	}
	captureWebSocketRequest(logDetail, firstFrame)
	accounting.requestBytes = int64(len(firstFrame))
	firstRequestBytes := int64(len(firstFrame))
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
		writeNativeWebSocketError(downstream, http.StatusBadRequest, "model_required", err.Error())
		return session, meta, err
	}
	if !key.AllowsModel(meta.Model) {
		err = fmt.Errorf("API key is not allowed to use model %q", meta.Model)
		accounting.errorHTTP, accounting.errorCode = http.StatusForbidden, "model_not_allowed"
		writeNativeWebSocketError(downstream, http.StatusForbidden, "model_not_allowed", err.Error())
		return session, meta, err
	}
	if !accounting.billable {
		admission, price, code, admitErr := a.admitNativeWebSocket(r.Context(), key, meta, requestID, r.URL.Path)
		if admitErr != nil {
			accounting.errorHTTP, accounting.errorCode = nativeWebSocketAdmissionError(code)
			writeNativeWebSocketError(downstream, accounting.errorHTTP, code, admitErr.Error())
			return session, meta, admitErr
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
				writeNativeWebSocketError(downstream, http.StatusBadRequest, "invalid_request", "unable to resolve websocket model")
				return session, meta, err
			}
		}
	}
	accounting.currentMeta = meta
	accounting.currentStarted = time.Now()
	accounting.currentRequest = firstRequestBytes
	accounting.currentForwarded = int64(len(firstFrame))
	accounting.currentResponse = 0

	upstream, response, err := a.dialEmbeddedCPAWebSocket(r.Context(), r, accounting.admission, requestID)
	if err != nil {
		classified := userFacingError{Status: http.StatusServiceUnavailable, Code: "model_account_unavailable", Message: "无法连接当前订阅的模型账户，请稍后重试或联系管理员", Retryable: true}
		if response != nil {
			classified.UpstreamStatus = response.StatusCode
			if response.Body != nil {
				payload, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
				_ = response.Body.Close()
				classified = a.classifyUpstreamError(response.StatusCode, payload, accounting.admission)
			}
		}
		accounting.errorHTTP, accounting.errorCode = classified.Status, classified.Code
		writeNativeWebSocketError(downstream, classified.Status, classified.Code, classified.Message)
		return session, meta, err
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	defer upstream.Close()
	upstream.SetReadLimit(a.cfg.CPAMaxRequestBytes)
	if err = upstream.WriteMessage(messageType, firstFrame); err != nil {
		return session, meta, err
	}
	accounting.forwardedBytes = int64(len(firstFrame))
	session.established = true
	heartbeatStop := make(chan struct{})
	defer close(heartbeatStop)
	go func() {
		if heartbeatErr := keepWebSocketAlive(heartbeatStop, downstream, nativeWebSocketHeartbeatInterval); heartbeatErr != nil {
			_ = downstream.Close()
			_ = upstream.Close()
		}
	}()

	stopCancel := context.AfterFunc(r.Context(), func() {
		_ = downstream.Close()
		_ = upstream.Close()
	})
	defer stopCancel()
	type pumpResult struct {
		source string
		err    error
	}
	results := make(chan pumpResult, 2)
	go func() {
		results <- pumpResult{source: "downstream", err: pumpWebSocketMessages(downstream, upstream, func(payload []byte) ([]byte, error) {
			accounting.mu.Lock()
			defer accounting.mu.Unlock()
			accounting.requestBytes += int64(len(payload))
			forwarded, nextMeta, startsTurn, prepareErr := a.prepareNativeWebSocketRequest(payload, r.URL, key, accounting)
			if prepareErr != nil {
				return nil, prepareErr
			}
			accounting.forwardedBytes += int64(len(forwarded))
			if startsTurn {
				accounting.currentMeta = nextMeta
				accounting.currentStarted = time.Now()
				accounting.currentRequest = int64(len(payload))
				accounting.currentForwarded = int64(len(forwarded))
				accounting.currentResponse = 0
			} else {
				accounting.currentRequest += int64(len(payload))
				accounting.currentForwarded += int64(len(forwarded))
			}
			return forwarded, nil
		})}
	}()
	go func() {
		results <- pumpResult{source: "upstream", err: pumpWebSocketMessages(upstream, downstream, func(payload []byte) ([]byte, error) {
			accounting.mu.Lock()
			defer accounting.mu.Unlock()
			accounting.responseBytes += int64(len(payload))
			accounting.currentResponse += int64(len(payload))
			accounting.terminalSeen = accounting.terminalSeen || isNativeWebSocketTerminalEvent(payload)
			if !isNativeWebSocketUsageTerminalEvent(payload) {
				return payload, nil
			}
			turn := parseNativeWebSocketUsage(payload)
			cumulative := accounting.result
			mergeNativeWebSocketResult(&cumulative, turn)
			if accounting.persistTurn != nil {
				entry := nativeWebSocketBillingEntry{
					Meta: accounting.currentMeta, Result: turn, Payload: append([]byte(nil), payload...),
					StartedAt: accounting.currentStarted, RequestBytes: accounting.currentRequest,
					ForwardedBytes: accounting.currentForwarded, ResponseBytes: accounting.currentResponse,
				}
				inserted, persistErr := accounting.persistTurn(entry, cumulative)
				if persistErr != nil {
					return nil, fmt.Errorf("persist websocket terminal usage: %w", persistErr)
				}
				if !inserted {
					return payload, nil
				}
			} else {
				if accounting.turnsSeen == 0 {
					accounting.pricingComplete = turn.Found
				} else {
					accounting.pricingComplete = accounting.pricingComplete && turn.Found
				}
				accounting.turnsSeen++
			}
			accounting.result = cumulative
			return payload, nil
		})}
	}()

	first := <-results
	if first.source == "upstream" {
		forwardWebSocketClose(downstream, normalizedUpstreamWebSocketClose(first.err, accounting.terminalSeen))
	} else {
		forwardWebSocketClose(upstream, first.err)
	}
	// Give the peer a brief opportunity to acknowledge the close frame. Closing
	// the TCP connection immediately after WriteControl can make an otherwise
	// successful session surface as close 1006 at the client or reverse proxy.
	select {
	case <-results:
	case <-time.After(time.Second):
	}
	_ = downstream.Close()
	_ = upstream.Close()
	accounting.mu.Lock()
	meta = accounting.currentMeta
	accounting.mu.Unlock()
	if first.source == "downstream" && clientWebSocketDisconnect(first.err) {
		return session, meta, nil
	}
	if first.source == "upstream" && accounting.terminalSeen && clientWebSocketDisconnect(first.err) {
		return session, meta, nil
	}
	return session, meta, first.err
}

func keepWebSocketAlive(stop <-chan struct{}, conn *websocket.Conn, interval time.Duration) error {
	if conn == nil || interval <= 0 {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return nil
		case timestamp := <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, timestamp.Add(10*time.Second)); err != nil {
				return err
			}
		}
	}
}

func normalizedUpstreamWebSocketClose(err error, terminalResponseSeen bool) error {
	if terminalResponseSeen && clientWebSocketDisconnect(err) {
		return &websocket.CloseError{Code: websocket.CloseNormalClosure}
	}
	return err
}

func nativeWebSocketAdmissionError(code string) (int, string) {
	switch code {
	case "subscription_not_assigned", "model_not_allowed":
		return http.StatusForbidden, code
	case "insufficient_balance", "subscription_quota_exhausted", "model_account_quota_exhausted":
		return http.StatusPaymentRequired, code
	case "pricing_unavailable", "subscription_pricing_unavailable", "subscription_unavailable", "model_account_unavailable", "model_account_auth_failed":
		return http.StatusServiceUnavailable, code
	default:
		return http.StatusInternalServerError, firstNonEmptyString(code, "admission_internal_error")
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

func (a *App) prepareNativeWebSocketRequest(payload []byte, requestURL *url.URL, key store.KeyContext,
	accounting *nativeWebSocketAccounting) ([]byte, requestMeta, bool, error) {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Type != "response.create" {
		return payload, accounting.currentMeta, false, nil
	}
	frameMeta := readRequestMeta(payload, "")
	nextMeta := accounting.currentMeta
	if frameMeta.Model != "" {
		resolved := resolveAPIKeyModel(frameMeta.Model, key.ModelAliases)
		if !key.AllowsModel(resolved.Model) {
			return nil, nextMeta, true, fmt.Errorf("API key is not allowed to use model %q", resolved.Model)
		}
		nextMeta.Model = resolved.Model
		nextMeta.RequestedModel = resolved.RequestedModel
		nextMeta.ModelAlias = resolved.ModelAlias
	}
	if frameMeta.ServiceTier != "" {
		nextMeta.ServiceTier = frameMeta.ServiceTier
	}
	if frameMeta.ReasoningEffort != "" {
		nextMeta.ReasoningEffort = frameMeta.ReasoningEffort
	}
	nextMeta.Stream = true
	forwarded := payload
	if frameMeta.Model != "" && a.nativeCPARuntime != nil {
		upstreamModel := a.nativeCPARuntime.ResolveCredentialModel(accounting.admission.CPAAuthID, nextMeta.Model)
		if upstreamModel != "" && upstreamModel != frameMeta.Model {
			requestCopy := url.URL{}
			if requestURL != nil {
				requestCopy = *requestURL
			}
			var err error
			forwarded, err = rewriteRequestModel(payload, &requestCopy, frameMeta.Model, upstreamModel)
			if err != nil {
				return nil, nextMeta, true, err
			}
		}
	}
	return forwarded, nextMeta, true, nil
}

func pumpWebSocketMessages(source, destination *websocket.Conn, transform func([]byte) ([]byte, error)) error {
	for {
		messageType, payload, err := source.ReadMessage()
		if err != nil {
			return err
		}
		if transform != nil {
			if payload, err = transform(payload); err != nil {
				return err
			}
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

func isNativeWebSocketTerminalEvent(payload []byte) bool {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	switch event.Type {
	case "error", "response.completed", "response.incomplete", "response.done":
		return true
	default:
		return false
	}
}

func isNativeWebSocketUsageTerminalEvent(payload []byte) bool {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	switch event.Type {
	case "response.completed", "response.incomplete", "response.done":
		return true
	default:
		return false
	}
}

func (a *App) admitNativeWebSocket(ctx context.Context, key store.KeyContext, meta requestMeta, requestID, endpoint string) (
	store.Admission, *store.ResolvedPrice, string, error) {
	dimensions := pricing.Dimensions{APIGroupKey: key.ID, Model: meta.Model, ServiceTier: meta.ServiceTier,
		ReasoningEffort: meta.ReasoningEffort, Endpoint: endpoint}
	price, priceErr := a.store.ResolvePrice(ctx, dimensions)
	priceConfigured := priceErr == nil
	if !priceConfigured && a.cfg.UnpricedModelPolicy == "deny" {
		return store.Admission{}, nil, "pricing_unavailable", fmt.Errorf("该模型尚未配置价格，请联系管理员完善计费配置")
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
		classified := admissionUserError(err)
		return store.Admission{}, nil, classified.Code, fmt.Errorf("%s", classified.Message)
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

func writeNativeWebSocketError(conn *websocket.Conn, status int, code, message string) {
	payload, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{
		"type": errorTypeForStatus(status), "code": code, "message": message,
		"details": map[string]any{"retryable": defaultErrorRetryable(status, code)},
	}})
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}

func normalWebSocketClose(err error) bool {
	return err == nil || errors.Is(err, context.Canceled) || websocket.IsCloseError(err,
		websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived)
}

// clientWebSocketDisconnect identifies peer-side shutdowns that are not a
// gateway failure. In particular, connectivity probes and process teardown
// commonly close the TCP connection without sending a WebSocket close frame,
// which gorilla/websocket reports as close code 1006 with unexpected EOF.
func clientWebSocketDisconnect(err error) bool {
	if normalWebSocketClose(err) || errors.Is(err, io.EOF) {
		return true
	}
	return websocket.IsCloseError(err, websocket.CloseAbnormalClosure)
}

func errorString(err error) string {
	if err == nil || normalWebSocketClose(err) {
		return ""
	}
	return err.Error()
}
