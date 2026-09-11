package upstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
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
	downstream, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, request, nil)
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
	if !ok || (!credential.WebSockets && !websocketPrewarm(first)) {
		_ = downstream.WriteJSON(map[string]any{"type": "error", "error": map[string]any{"type": "model_account_unavailable", "message": "no upstream credential can serve this model"}})
		return
	}
	downstreamFrames := make(chan websocketFrame, 1)
	go readWebSocketFrames(downstream, downstreamFrames)
	var upstream *websocket.Conn
	var upstreamFrames <-chan websocketFrame
	var restorer *toolResponseRestorer
	terminalSeen := false

	connect := func() error {
		connection, response, dialErr := credential.dialWebSocket(request.Context(), request.URL.Path, request.Header)
		if dialErr != nil {
			r.mu.RLock()
			threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
			r.mu.RUnlock()
			credential.record(false, dialErr.Error(), true, threshold, cooldown)
			if response != nil {
				return fmt.Errorf("upstream websocket returned HTTP %d", response.StatusCode)
			}
			return dialErr
		}
		upstream = connection
		r.mu.RLock()
		threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
		r.mu.RUnlock()
		credential.record(true, "", false, threshold, cooldown)
		frames := make(chan websocketFrame, 1)
		upstreamFrames = frames
		go readWebSocketFrames(upstream, frames)
		terminalSeen = false
		return nil
	}
	forward := func(kind int, payload []byte) error {
		if websocketPrewarm(payload) {
			id := generatedID("resp")
			_ = downstream.WriteJSON(map[string]any{"type": "response.created", "response": map[string]any{"id": id, "object": "response", "status": "in_progress", "model": model, "output": []any{}}})
			return downstream.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"id": id, "object": "response", "status": "completed", "model": model, "output": []any{}, "usage": map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}})
		}
		if !credential.WebSockets {
			return errors.New("upstream WebSocket is disabled for this credential")
		}
		payload = rewriteJSONModel(payload, credential.ModelRoutes[strings.ToLower(model)])
		if credential.Provider == "codex" {
			if adapted, adaptErr := prepareCodexWebsiteRequest(payload); adaptErr == nil {
				payload = adapted.Body
			}
		}
		if credential.Provider == "xai" {
			var current *toolResponseRestorer
			payload, current = lowerCodexTools(payload)
			payload = sanitizeXAIResponses(payload)
			if current != nil {
				restorer = current
			}
		}
		if upstream == nil {
			if connectErr := connect(); connectErr != nil {
				return connectErr
			}
		}
		return upstream.WriteMessage(kind, payload)
	}
	if err = forward(messageType, first); err != nil {
		_ = downstream.WriteJSON(map[string]any{"type": "error", "error": map[string]any{"type": "upstream_websocket_failed", "message": err.Error()}})
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
				_ = downstream.WriteJSON(map[string]any{"type": "error", "error": map[string]any{"type": "upstream_websocket_failed", "message": err.Error()}})
				return
			}
		case message := <-upstreamFrames:
			if message.err != nil {
				if upstream != nil {
					_ = upstream.Close()
				}
				upstream, upstreamFrames = nil, nil
				if terminalSeen {
					continue
				}
				return
			}
			payload := message.payload
			if restorer != nil {
				payload = restorer.restore(payload)
				if len(payload) == 0 {
					continue
				}
			}
			terminalSeen = terminalSeen || websocketTerminal(payload)
			if err = downstream.WriteMessage(message.kind, payload); err != nil {
				return
			}
		}
	}
}

func readWebSocketFrames(connection *websocket.Conn, output chan<- websocketFrame) {
	for {
		kind, payload, err := connection.ReadMessage()
		output <- websocketFrame{kind: kind, payload: payload, err: err}
		if err != nil {
			return
		}
	}
}

func websocketPrewarm(payload []byte) bool {
	var event map[string]any
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	generate, exists := event["generate"]
	value, _ := generate.(bool)
	return exists && !value
}

func websocketTerminal(payload []byte) bool {
	var event map[string]any
	return json.Unmarshal(payload, &event) == nil && anyString(event["type"]) == "response.completed"
}

func (c *nativeCredential) dialWebSocket(ctx context.Context, path string, source http.Header) (*websocket.Conn, *http.Response, error) {
	target, err := c.websocketURL(path)
	if err != nil {
		return nil, nil, err
	}
	header := make(http.Header)
	copyProviderHeaders(header, source)
	c.authorize(header, canonicalInferencePath(path))
	dialer := websocket.Dialer{EnableCompression: true}
	if transport, ok := c.client.Transport.(*http.Transport); ok {
		dialer.Proxy = transport.Proxy
		dialer.NetDialContext = transport.DialContext
		dialer.TLSClientConfig = transport.TLSClientConfig
	}
	return dialer.DialContext(ctx, target, header)
}

func websocketModel(payload []byte) string {
	var root map[string]any
	if json.Unmarshal(payload, &root) != nil {
		return ""
	}
	if model := anyString(root["model"]); model != "" {
		return model
	}
	if response, ok := root["response"].(map[string]any); ok {
		return anyString(response["model"])
	}
	return ""
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
	query.Set("experimental", "true")
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
