package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/dataplane"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

const responsesWebSocketBeta = "responses_websockets=2026-02-06"

func (a *App) proxyNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string,
	admission store.Admission, meta requestMeta, started time.Time, billable bool, logContext requestLogContext) {
	connected, resolvedMeta, err := a.serveNativeWebSocket(w, r, key, admission, meta, requestID)
	if resolvedMeta.Model != "" {
		meta = resolvedMeta
	}
	statusCode := http.StatusSwitchingProtocols
	if !connected {
		statusCode = http.StatusBadGateway
		logContext.errorCode = "websocket_proxy_error"
	}
	actual := max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
	settled := !billable
	if billable {
		var settleErr error
		if connected {
			settleErr = a.store.SettleRequestReservation(context.Background(), requestID, actual, false)
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
	}
	logContext.detail.StageTimings = timingJSON(map[string]int64{"total_ms": time.Since(started).Milliseconds()})
	a.writeRequestLog(key, requestID, admission, meta, r, statusCode, started, nil, false, settled, actual, errorString(err), logContext)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) serveNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, admission store.Admission,
	meta requestMeta, requestID string) (bool, requestMeta, error) {
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
	plan, credential, err := a.credentials.Plan(r.URL.Path, admission.CPAAuthID, meta.Model, true)
	if err != nil {
		writeNativeWebSocketError(downstream, "route_unavailable", err.Error())
		return false, meta, err
	}
	if plan.Upstream != dataplane.ProtocolCodex {
		err = fmt.Errorf("provider %q does not support Responses WebSocket", plan.Provider)
		writeNativeWebSocketError(downstream, "websocket_unsupported", err.Error())
		return false, meta, err
	}
	upstream, response, err := a.dialNativeWebSocket(r, plan, credential, subprotocols)
	if err != nil && response != nil && response.StatusCode == http.StatusUnauthorized &&
		(plan.Provider == "codex" || plan.Provider == "xai" || plan.Provider == "grok") {
		_ = response.Body.Close()
		if refreshErr := a.authManager.Refresh(r.Context(), credential.ID); refreshErr == nil {
			plan, credential, err = a.credentials.Plan(r.URL.Path, admission.CPAAuthID, meta.Model, true)
			if err == nil {
				upstream, response, err = a.dialNativeWebSocket(r, plan, credential, subprotocols)
			}
		}
	}
	if response != nil {
		defer response.Body.Close()
	}
	if err != nil {
		message := err.Error()
		if response != nil {
			payload, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
			if len(payload) > 0 {
				message = fmt.Sprintf("upstream websocket returned %d: %s", response.StatusCode, strings.TrimSpace(string(payload)))
			}
		}
		writeNativeWebSocketError(downstream, "upstream_unavailable", message)
		return false, meta, err
	}
	defer upstream.Close()
	upstream.SetReadLimit(64 << 20)
	firstFrame, err = a.engine.TranslateWebSocketRequest(plan, firstFrame, r.Header)
	if err != nil {
		writeNativeWebSocketError(downstream, "translation_failed", err.Error())
		return false, meta, err
	}
	if err = upstream.WriteMessage(websocket.TextMessage, firstFrame); err != nil {
		return false, meta, err
	}
	return true, meta, relayNativeWebSockets(r.Context(), downstream, upstream, func(payload []byte) ([]byte, error) {
		return a.engine.TranslateWebSocketRequest(plan, payload, r.Header)
	})
}

func (a *App) dialNativeWebSocket(r *http.Request, plan dataplane.RoutePlan, credential dataplane.Credential,
	subprotocols []string) (*websocket.Conn, *http.Response, error) {
	target := *plan.Endpoint
	switch strings.ToLower(target.Scheme) {
	case "https":
		target.Scheme = "wss"
	case "http":
		target.Scheme = "ws"
	case "wss", "ws":
	default:
		return nil, nil, fmt.Errorf("unsupported websocket scheme %q", target.Scheme)
	}
	headers := codexWebSocketHeaders(r.Header)
	request := &http.Request{Header: headers}
	if err := credential.Apply(request); err != nil {
		return nil, nil, err
	}
	beta := strings.TrimSpace(headers.Get("OpenAI-Beta"))
	if !strings.Contains(beta, "responses_websockets=") {
		headers.Set("OpenAI-Beta", responsesWebSocketBeta)
	}
	dialer, err := a.transports.WebSocketDialer(credential.ProxyURL)
	if err != nil {
		return nil, nil, err
	}
	dialer.Subprotocols = append([]string(nil), subprotocols...)
	return dialer.DialContext(r.Context(), target.String(), headers)
}

func codexWebSocketHeaders(source http.Header) http.Header {
	allowedHeaders := map[string]struct{}{
		"openai-beta": {}, "user-agent": {}, "originator": {}, "version": {},
		"session_id": {}, "conversation_id": {}, "x-client-request-id": {},
		"x-codex-beta-features": {}, "x-codex-turn-state": {}, "x-codex-turn-metadata": {},
		"x-responsesapi-include-timing-metrics": {}, "x-openai-internal-codex-responses-lite": {},
	}
	headers := make(http.Header)
	for name, values := range source {
		if _, ok := allowedHeaders[strings.ToLower(name)]; !ok {
			continue
		}
		headers[name] = append([]string(nil), values...)
	}
	return headers
}

func relayNativeWebSockets(ctx context.Context, downstream, upstream *websocket.Conn,
	translate func([]byte) ([]byte, error)) error {
	errorsCh := make(chan error, 2)
	go copyNativeWebSocket(upstream, downstream, translate, errorsCh)
	go copyNativeWebSocket(downstream, upstream, nil, errorsCh)
	var err error
	select {
	case err = <-errorsCh:
	case <-ctx.Done():
		err = ctx.Err()
	}
	code, reason := websocket.CloseNormalClosure, ""
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		code, reason = closeErr.Code, closeErr.Text
	} else if err != nil && !errors.Is(err, context.Canceled) {
		code, reason = websocket.CloseInternalServerErr, "relay closed"
	}
	payload := websocket.FormatCloseMessage(code, reason)
	_ = downstream.WriteControl(websocket.CloseMessage, payload, time.Now().Add(time.Second))
	_ = upstream.WriteControl(websocket.CloseMessage, payload, time.Now().Add(time.Second))
	return err
}

func copyNativeWebSocket(destination, source *websocket.Conn, translate func([]byte) ([]byte, error), errorsCh chan<- error) {
	for {
		messageType, payload, err := source.ReadMessage()
		if err != nil {
			errorsCh <- err
			return
		}
		if translate != nil && messageType == websocket.TextMessage {
			payload, err = translate(payload)
			if err != nil {
				errorsCh <- err
				return
			}
		}
		if err = destination.WriteMessage(messageType, payload); err != nil {
			errorsCh <- err
			return
		}
	}
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
