package upstream

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
)

type websocketFrame struct {
	kind    int
	payload []byte
	err     error
}

func isRuntimeWebSocket(request *http.Request) bool {
	return websocket.IsWebSocketUpgrade(request) && strings.HasSuffix(strings.TrimRight(request.URL.Path, "/"), "/responses")
}

func (r *nativeRuntime) serveWebSocket(w http.ResponseWriter, request *http.Request) {
	upgradeHeaders := http.Header{}
	if model := request.Header.Get("X-Relay-Upstream-Model"); model != "" {
		selected, ok := r.selectCredential(model, request.Header.Get("X-Relay-Upstream-Credential-ID"), "")
		if !ok {
			writeRuntimeError(w, 503, "model_account_unavailable", "no upstream credential can serve this model")
			return
		}
		if !selected.WebSockets {
			writeRuntimeError(w, 426, "websocket_disabled", "Send this Responses request over HTTP instead.")
			return
		}
		request.Header.Set("X-Relay-Upstream-Credential-ID", selected.ID)
		upgradeHeaders.Set("X-Relay-Selected-Credential-ID", selected.ID)
	}
	downstream, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, request, upgradeHeaders)
	if err != nil {
		return
	}
	defer downstream.Close()
	messageType, first, err := downstream.ReadMessage()
	if err != nil {
		return
	}
	model := websocketModel(first)
	pinned := strings.TrimSpace(request.Header.Get("X-Relay-Upstream-Credential-ID"))
	credential, ok := r.selectCredential(model, pinned, sessionAffinityKey(first, request.Header))
	if !ok || !credential.WebSockets {
		_ = downstream.WriteJSON(map[string]any{"type": "error", "status": 503, "error": map[string]any{"type": "server_error", "code": "model_account_unavailable", "message": "no upstream credential can serve this model", "source": "relay"}})
		return
	}
	frameContext, stopFrames := context.WithCancel(request.Context())
	defer stopFrames()
	downstreamFrames := make(chan websocketFrame, 1)
	go readWebSocketFrames(frameContext, downstream, downstreamFrames)
	var upstream *websocket.Conn
	defer func() {
		if upstream != nil {
			_ = upstream.Close()
		}
	}()
	var upstreamFrames <-chan websocketFrame
	terminalSeen := false
	var replayAfterTerminal *websocketFrame

	connect := func(payload []byte) error {
		header := request.Header.Clone()
		credential.applyCodexRoutingHint(header, payload)
		connection, response, dialErr := r.dialProviderWebSocket(request.Context(), credential, request.URL.Path, header)
		if dialErr != nil {
			r.mu.RLock()
			threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
			r.mu.RUnlock()
			// Refusing the socket is a transport limitation, not a broken account.
			unhealthy := response == nil || response.StatusCode == 401 || response.StatusCode == 403 || providerAvailabilityStatus(response.StatusCode)
			if unhealthy {
				credential.record(false, dialErr.Error(), true, threshold, cooldown)
			} else {
				credential.releaseProbe()
			}
			if response != nil {
				if response.Body != nil {
					_ = response.Body.Close()
				}
				return fmt.Errorf("upstream websocket returned HTTP %d", response.StatusCode)
			}
			return dialErr
		}
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		upstream = connection
		r.mu.RLock()
		threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
		r.mu.RUnlock()
		credential.record(true, "", false, threshold, cooldown)
		frames := make(chan websocketFrame, 1)
		upstreamFrames = frames
		go readWebSocketFrames(frameContext, upstream, frames)
		terminalSeen = false
		return nil
	}
	forward := func(kind int, payload []byte) error {
		if jsonString(payload, "type") != "response.create" {
			if upstream == nil {
				return errors.New("first WebSocket message must be response.create")
			}
			return upstream.WriteMessage(kind, payload)
		}
		if !credential.WebSockets {
			return errors.New("upstream WebSocket is disabled for this credential")
		}
		// A client can send the next full turn before the reader observes the
		// previous turn's EOF. Retain it until the first upstream frame, so that
		// an EOF in that gap reconnects instead of silently dropping the turn.
		replayAfterTerminal = nil
		if upstream != nil && terminalSeen && websocketFullRequest(payload) {
			replayAfterTerminal = &websocketFrame{kind: kind, payload: payload}
		}
		if turnModel := websocketModel(payload); turnModel != "" {
			if _, eligible := r.selectCredential(turnModel, credential.ID, ""); !eligible {
				return errors.New("this WebSocket account cannot serve the requested model")
			}
			model = turnModel
		}
		payload = rewriteJSONModel(payload, credential.ModelRoutes[strings.ToLower(model)])
		if credential.APIKey == "" {
			if adapted, adaptErr := prepareCodexWebsiteRequest(payload); adaptErr == nil {
				payload = adapted.Body
			}
		}

		if upstream == nil {
			if connectErr := connect(payload); connectErr != nil {
				return connectErr
			}
		}
		terminalSeen = false
		return upstream.WriteMessage(kind, payload)
	}
	if err = forward(messageType, first); err != nil {
		_ = downstream.WriteJSON(map[string]any{"type": "error", "status": 502, "error": map[string]any{"type": "server_error", "code": "upstream_websocket_failed", "message": err.Error(), "source": "upstream"}})
		return
	}
	for {
		select {
		case <-request.Context().Done():
			if upstream != nil {
				_ = upstream.Close()
			}
			return
		case message := <-downstreamFrames:
			if message.err != nil {
				if upstream != nil {
					_ = upstream.Close()
				}
				return
			}
			if err = forward(message.kind, message.payload); err != nil {
				if pending := replayAfterTerminal; pending != nil {
					_ = upstream.Close()
					upstream, upstreamFrames = nil, nil
					err = forward(pending.kind, pending.payload)
				}
				if err == nil {
					continue
				}
				_ = downstream.WriteJSON(map[string]any{"type": "error", "status": 502, "error": map[string]any{"type": "server_error", "code": "upstream_websocket_failed", "message": err.Error(), "source": "upstream"}})
				return
			}
		case message := <-upstreamFrames:
			if message.err != nil {
				if upstream != nil {
					_ = upstream.Close()
				}
				upstream, upstreamFrames = nil, nil
				if pending := replayAfterTerminal; pending != nil {
					if err = forward(pending.kind, pending.payload); err != nil {
						_ = downstream.WriteJSON(map[string]any{"type": "error", "status": 502, "error": map[string]any{"type": "server_error", "code": "upstream_websocket_failed", "message": err.Error(), "source": "upstream"}})
						return
					}
					continue
				}
				if terminalSeen {
					continue
				}
				return
			}
			payload := message.payload
			replayAfterTerminal = nil

			terminalSeen = terminalSeen || websocketTerminal(payload)
			if err = downstream.WriteMessage(message.kind, payload); err != nil {
				return
			}
		}
	}
}

func websocketFullRequest(payload []byte) bool {
	if !gjson.ValidBytes(payload) || strings.TrimSpace(gjson.GetBytes(payload, "type").Str) != "response.create" || strings.TrimSpace(gjson.GetBytes(payload, "previous_response_id").Str) != "" {
		return false
	}
	return gjson.GetBytes(payload, "input").Type != gjson.Null
}

func readWebSocketFrames(ctx context.Context, connection *websocket.Conn, output chan<- websocketFrame) {
	for {
		kind, payload, err := connection.ReadMessage()
		select {
		case output <- websocketFrame{kind: kind, payload: payload, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func websocketTerminal(payload []byte) bool {
	switch gjson.GetBytes(payload, "type").Str {
	case "response.completed", "response.failed", "response.incomplete":
		return gjson.ValidBytes(payload)
	default:
		return false
	}
}

// A failed WebSocket handshake has not started a generation. Refresh and
// retry a definitive 401 once, using the same account as HTTP Responses.
func (r *nativeRuntime) dialProviderWebSocket(ctx context.Context, credential *nativeCredential, path string, source http.Header) (*websocket.Conn, *http.Response, error) {
	if credential.tokenNeedsRefresh() {
		if err := r.refreshCredential(ctx, credential); err != nil {
			return nil, nil, fmt.Errorf("%w: %w", errCredentialRefresh, err)
		}
	}
	connection, response, err := credential.dialWebSocket(ctx, path, source)
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized || !credential.hasRefreshToken() {
		return connection, response, err
	}
	if response.Body != nil {
		_ = response.Body.Close()
	}
	if refreshErr := r.refreshCredential(ctx, credential); refreshErr != nil {
		return nil, response, fmt.Errorf("%w: %w", errCredentialRefresh, refreshErr)
	}
	return credential.dialWebSocket(ctx, path, source)
}

func (c *nativeCredential) dialWebSocket(ctx context.Context, path string, source http.Header) (*websocket.Conn, *http.Response, error) {
	target, err := c.websocketURL(path)
	if err != nil {
		return nil, nil, err
	}
	header := make(http.Header)
	copyProviderHeaders(header, source)
	if header.Get("OpenAI-Beta") == "" {
		header.Set("OpenAI-Beta", "responses_websockets=2026-02-06")
	}
	c.authorize(header, canonicalInferencePath(path))
	dialer := websocket.Dialer{EnableCompression: true, HandshakeTimeout: 30 * time.Second}
	if transport, ok := c.client.Transport.(*http.Transport); ok {
		dialer.Proxy = transport.Proxy
		dialer.NetDialContext = transport.DialContext
		if transport.TLSClientConfig != nil {
			dialer.TLSClientConfig = transport.TLSClientConfig.Clone()
		}
	}
	if dialer.TLSClientConfig == nil {
		dialer.TLSClientConfig = &tls.Config{}
	}
	// Gorilla uses RFC 6455's HTTP/1.1 Upgrade, not HTTP/2 extended CONNECT.
	// net/http may have added h2 to its TLS config after an ordinary request.
	// Keep account trust/proxy settings, but never share or mutate HTTP's ALPN.
	dialer.TLSClientConfig.NextProtos = []string{"http/1.1"}
	return dialer.DialContext(ctx, target, header)
}

func websocketModel(payload []byte) string {
	if !gjson.ValidBytes(payload) {
		return ""
	}
	if model := strings.TrimSpace(gjson.GetBytes(payload, "model").Str); model != "" {
		return model
	}
	return strings.TrimSpace(gjson.GetBytes(payload, "response.model").Str)
}

func (c *nativeCredential) websocketURL(path string) (string, error) {
	parsed, err := url.Parse(c.upstreamURL(canonicalInferencePath(path)))
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	case "wss", "ws":
	default:
		return "", errors.New("unsupported upstream WebSocket scheme")
	}
	query := parsed.Query()
	if c.APIKey == "" {
		query.Set("experimental", "true")
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
