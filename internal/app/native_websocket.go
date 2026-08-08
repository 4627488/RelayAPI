package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/dataplane"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

const responsesWebSocketBeta = "responses_websockets=2026-02-06"

func (a *App) proxyNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string,
	admission store.Admission, meta requestMeta, started time.Time, billable bool, logContext requestLogContext) {
	connected, resolvedMeta, err := a.serveNativeWebSocket(w, r, key, admission, meta, requestID, logContext.detail)
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
		if connected {
			logContext.errorCode = "websocket_session_error"
		}
		logContext.detail.ErrorName = logContext.errorCode
		logContext.detail.ErrorMessage = boundedErrorText(err.Error())
	}
	duration := time.Since(started).Milliseconds()
	logContext.detail.StageTimings = timingJSON(map[string]int64{"websocket_duration_ms": duration, "total_ms": duration})
	a.writeRequestLog(key, requestID, admission, meta, r, statusCode, started, nil, false, settled, actual, errorString(err), logContext)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) serveNativeWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, admission store.Admission,
	meta requestMeta, requestID string, logDetail *store.LogDetailInput) (bool, requestMeta, error) {
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
	defer a.engine.CloseWebSocketSession(plan.Provider, requestID)
	connected := false
	frame := firstFrame
	for {
		requireExisting := connected && websocketFrameRequiresSession(frame)
		stream, executeErr := a.engine.ExecuteWebSocketTurn(r.Context(), requestID, plan, credential, r.Header, frame, requireExisting)
		if executeErr != nil && executorStatusCode(executeErr) == http.StatusUnauthorized &&
			(plan.Provider == "codex" || plan.Provider == "xai" || plan.Provider == "grok") {
			if refreshErr := a.authManager.Refresh(r.Context(), credential.ID); refreshErr == nil {
				plan, credential, executeErr = a.credentials.Plan(r.URL.Path, admission.CPAAuthID, meta.Model, true)
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
		if err = forwardExecutorWebSocketTurn(r.Context(), downstream, stream.Chunks); err != nil {
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
	chunks <-chan cliproxyexecutor.StreamChunk) error {
	completed := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case chunk, ok := <-chunks:
			if !ok {
				if !completed {
					return fmt.Errorf("upstream stream closed before response.completed")
				}
				return nil
			}
			if chunk.Err != nil {
				return chunk.Err
			}
			for _, payload := range websocketPayloadsFromStreamChunk(chunk.Payload) {
				var event struct {
					Type string `json:"type"`
				}
				_ = json.Unmarshal(payload, &event)
				if event.Type == "response.completed" || event.Type == "response.incomplete" || event.Type == "response.done" {
					completed = true
				}
				if err := downstream.WriteMessage(websocket.TextMessage, payload); err != nil {
					return err
				}
			}
		}
	}
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
