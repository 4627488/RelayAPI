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
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/dataplane"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

const responsesWebSocketBeta = "responses_websockets=2026-02-06"

type nativeWebSocketAccounting struct {
	admission store.Admission
	price     *store.ResolvedPrice
	billable  bool
	result    billing.Result
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
		statusCode = http.StatusBadGateway
		logContext.errorCode = "websocket_proxy_error"
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

func (a *App) serveNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext,
	meta requestMeta, requestID string, logDetail *store.LogDetailInput, accounting *nativeWebSocketAccounting) (bool, requestMeta, error) {
	subprotocols := websocket.Subprotocols(r)
	upgrader := websocket.Upgrader{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
		Subprotocols:      subprotocols,
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
	if messageType != websocket.TextMessage || !json.Valid(firstFrame) {
		err = fmt.Errorf("first websocket message must be a JSON response.create frame")
		writeNativeWebSocketError(downstream, "invalid_request", err.Error())
		return false, meta, err
	}
	captureWebSocketRequest(logDetail, firstFrame)
	if meta.Model == "" {
		frameMeta := readRequestMeta(firstFrame, r.URL.Path)
		meta = resolveAPIKeyModel(frameMeta.Model, key.ModelAliases)
		meta.Stream = true
	}
	if meta.Model == "" {
		err = fmt.Errorf("response.create requires model")
		writeNativeWebSocketError(downstream, "model_required", err.Error())
		return false, meta, err
	}
	if !allowed(meta.Model, key.ModelAllowlist, key.TenantModels) {
		err = fmt.Errorf("API key is not allowed to use model %q", meta.Model)
		writeNativeWebSocketError(downstream, "model_not_allowed", err.Error())
		return false, meta, err
	}
	if !accounting.billable {
		admission, price, code, admitErr := a.admitNativeWebSocket(r.Context(), key, meta, requestID, r.URL.Path)
		if admitErr != nil {
			writeNativeWebSocketError(downstream, code, admitErr.Error())
			return false, meta, admitErr
		}
		accounting.admission = admission
		accounting.price = price
		accounting.billable = true
	}
	plan, credential, err := a.credentials.Plan(r.URL.Path, accounting.admission.CPAAuthID, meta.Model, true)
	if err != nil {
		writeNativeWebSocketError(downstream, "route_unavailable", err.Error())
		return false, meta, err
	}
	if plan.Upstream != dataplane.ProtocolCodex {
		err = fmt.Errorf("provider %q does not support Responses WebSocket", plan.Provider)
		writeNativeWebSocketError(downstream, "websocket_unsupported", err.Error())
		return false, meta, err
	}
	defer a.engine.CloseWebSocketSession(plan.Provider, requestID)
	connected := false
	frame := firstFrame
	for {
		requireExisting := connected && websocketFrameRequiresSession(frame)
		stream, executeErr := a.engine.ExecuteWebSocketTurn(r.Context(), requestID, plan, credential, r.Header, frame, requireExisting)
		if executeErr != nil && executorStatusCode(executeErr) == http.StatusUnauthorized &&
			(plan.Provider == "codex" || plan.Provider == "xai" || plan.Provider == "grok") {
			if refreshErr := a.authManager.Refresh(r.Context(), credential.ID); refreshErr == nil {
				plan, credential, executeErr = a.credentials.Plan(r.URL.Path, accounting.admission.CPAAuthID, meta.Model, true)
				if executeErr == nil {
					stream, executeErr = a.engine.ExecuteWebSocketTurn(r.Context(), requestID, plan, credential, r.Header, frame, requireExisting)
				}
			}
		}
		if executeErr != nil {
			writeNativeWebSocketError(downstream, "upstream_unavailable", executeErr.Error())
			return connected, meta, executeErr
		}
		connected = true
		turnResult, forwardErr := forwardExecutorWebSocketTurn(r.Context(), downstream, stream.Chunks)
		mergeNativeWebSocketResult(&accounting.result, turnResult)
		if forwardErr != nil {
			err = forwardErr
			return connected, meta, err
		}

		messageType, frame, err = downstream.ReadMessage()
		if err != nil {
			return connected, meta, err
		}
		if messageType != websocket.TextMessage || !json.Valid(frame) {
			err = fmt.Errorf("websocket message must be JSON")
			writeNativeWebSocketError(downstream, "invalid_request", err.Error())
			return connected, meta, err
		}
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

func websocketFrameRequiresSession(payload []byte) bool {
	var frame struct {
		Type               string `json:"type"`
		PreviousResponseID string `json:"previous_response_id"`
	}
	if json.Unmarshal(payload, &frame) != nil {
		return false
	}
	return frame.Type == "response.append" || strings.TrimSpace(frame.PreviousResponseID) != ""
}

func executorStatusCode(err error) int {
	var status interface{ StatusCode() int }
	if errors.As(err, &status) {
		return status.StatusCode()
	}
	return 0
}

func forwardExecutorWebSocketTurn(ctx context.Context, downstream *websocket.Conn,
	chunks <-chan cliproxyexecutor.StreamChunk) (billing.Result, error) {
	var result billing.Result
	completed := false
	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case chunk, ok := <-chunks:
			if !ok {
				if !completed {
					return result, fmt.Errorf("upstream stream closed before response.completed")
				}
				return result, nil
			}
			if chunk.Err != nil {
				return result, chunk.Err
			}
			for _, payload := range websocketPayloadsFromStreamChunk(chunk.Payload) {
				var event struct {
					Type string `json:"type"`
				}
				_ = json.Unmarshal(payload, &event)
				if event.Type == "response.completed" || event.Type == "response.incomplete" || event.Type == "response.done" {
					completed = true
					parsed := billing.ParseResponse(payload)
					mergeNativeWebSocketResult(&result, parsed)
				}
				if err := downstream.WriteMessage(websocket.TextMessage, payload); err != nil {
					return result, err
				}
			}
		}
	}
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

func websocketPayloadsFromStreamChunk(chunk []byte) [][]byte {
	trimmed := bytes.TrimSpace(chunk)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("[DONE]")) {
		return nil
	}
	if json.Valid(trimmed) {
		return [][]byte{bytes.Clone(trimmed)}
	}
	var payloads [][]byte
	for _, line := range bytes.Split(trimmed, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(line[len("data:"):])
		if json.Valid(payload) {
			payloads = append(payloads, bytes.Clone(payload))
		}
	}
	return payloads
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
