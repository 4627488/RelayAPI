package dataplane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

type Engine struct {
	Translator *Translator
	Transports *TransportPool
	Executors  *CompatibilityExecutors
}

type Exchange struct {
	Plan              RoutePlan
	OriginalRequest   []byte
	TranslatedRequest []byte
	Request           *http.Request
	Response          *http.Response
	ExecutorManaged   bool
}

func NewEngine(translator *Translator, transports *TransportPool) *Engine {
	return &Engine{Translator: translator, Transports: transports, Executors: NewCompatibilityExecutors()}
}

func (e *Engine) Do(ctx context.Context, plan RoutePlan, credential Credential, inboundHeaders http.Header, body []byte) (*Exchange, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if e == nil || e.Translator == nil || e.Transports == nil {
		return nil, fmt.Errorf("data plane engine is not initialized")
	}
	if exchange, handled, err := e.doCompatibilityExecutor(ctx, plan, credential, inboundHeaders, body); handled {
		return exchange, err
	}
	translated, err := e.Translator.TranslateRequest(plan.Inbound, plan.Upstream, plan.Model, body, plan.Stream)
	if err != nil {
		return nil, err
	}
	translated = normalizeProviderRequest(plan, translated, inboundHeaders)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, plan.Endpoint.String(), bytes.NewReader(translated))
	if err != nil {
		return nil, err
	}
	copyEndToEndHeaders(request.Header, inboundHeaders)
	request.Header.Set("Content-Type", "application/json")
	if plan.Stream || plan.Upstream == ProtocolCodex {
		request.Header.Set("Accept", "text/event-stream")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	if err := credential.Apply(request); err != nil {
		return nil, err
	}
	client, err := e.Transports.Client(credential.ProxyURL)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	return &Exchange{Plan: plan, OriginalRequest: bytes.Clone(body), TranslatedRequest: translated, Request: request, Response: response}, nil
}

// TranslateWebSocketRequest converts one downstream response.create frame to
// the selected provider protocol. WebSocket follow-up turns deliberately keep
// previous_response_id because it is the session continuation primitive.
func (e *Engine) TranslateWebSocketRequest(plan RoutePlan, body []byte, inboundHeaders http.Header) ([]byte, error) {
	if e == nil || e.Translator == nil {
		return nil, fmt.Errorf("data plane engine is not initialized")
	}
	translated, err := e.Translator.TranslateRequest(plan.Inbound, plan.Upstream, plan.Model, body, true)
	if err != nil {
		return nil, err
	}
	if plan.Upstream != ProtocolCodex || !json.Valid(translated) {
		return translated, nil
	}
	translated, _ = sjson.SetBytes(translated, "model", plan.Model)
	translated, _ = sjson.SetBytes(translated, "stream", true)
	translated, _ = sjson.SetBytes(translated, "type", "response.create")
	for _, field := range []string{"generate", "prompt_cache_retention", "safety_identifier", "stream_options"} {
		translated, _ = sjson.DeleteBytes(translated, field)
	}
	return normalizeCodexResponsesLite(translated, inboundHeaders), nil
}

func (e *Engine) CopyResponse(ctx context.Context, w io.Writer, exchange *Exchange, onFirstByte func()) error {
	if exchange == nil || exchange.Response == nil {
		return fmt.Errorf("exchange has no response")
	}
	if exchange.ExecutorManaged {
		return copyImmediate(w, exchange.Response.Body, onFirstByte)
	}
	if exchange.Plan.Stream {
		return e.copyStream(ctx, w, exchange, onFirstByte)
	}
	body, err := io.ReadAll(exchange.Response.Body)
	if err != nil {
		return err
	}
	if exchange.Plan.Upstream == ProtocolCodex && strings.Contains(strings.ToLower(exchange.Response.Header.Get("Content-Type")), "text/event-stream") {
		body, err = completedSSEPayload(body)
		if err != nil {
			return err
		}
	}
	body, err = e.Translator.TranslateResponse(ctx, exchange.Plan.Inbound, exchange.Plan.Upstream, exchange.Plan.Model, exchange.OriginalRequest, exchange.TranslatedRequest, body)
	if err != nil {
		return err
	}
	if len(body) > 0 && onFirstByte != nil {
		onFirstByte()
	}
	_, err = w.Write(body)
	return err
}

func (e *Engine) copyStream(ctx context.Context, w io.Writer, exchange *Exchange, onFirstByte func()) error {
	if exchange.Plan.Inbound == exchange.Plan.Upstream {
		return copyImmediate(w, exchange.Response.Body, onFirstByte)
	}
	reader := bufio.NewReaderSize(exchange.Response.Body, 32<<10)
	state := &StreamState{}
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			chunks, err := e.Translator.TranslateStreamLine(ctx, exchange.Plan.Inbound, exchange.Plan.Upstream, exchange.Plan.Model, exchange.OriginalRequest, exchange.TranslatedRequest, line, state)
			if err != nil {
				return err
			}
			for _, chunk := range chunks {
				chunk = frameStreamChunk(exchange.Plan.Inbound, chunk)
				if len(chunk) == 0 {
					continue
				}
				if onFirstByte != nil {
					onFirstByte()
					onFirstByte = nil
				}
				if _, err := w.Write(chunk); err != nil {
					return err
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if terminal := terminalStreamChunk(exchange.Plan.Inbound); len(terminal) > 0 {
					if onFirstByte != nil {
						onFirstByte()
					}
					_, err := w.Write(terminal)
					return err
				}
				return nil
			}
			return readErr
		}
	}
}

func frameStreamChunk(protocol Protocol, chunk []byte) []byte {
	if protocol != ProtocolOpenAI {
		return chunk
	}
	trimmed := bytes.TrimSpace(chunk)
	if len(trimmed) == 0 {
		return nil
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) || bytes.HasPrefix(trimmed, []byte("event:")) {
		return append(append([]byte(nil), trimmed...), '\n', '\n')
	}
	framed := make([]byte, 0, len(trimmed)+8)
	framed = append(framed, "data: "...)
	framed = append(framed, trimmed...)
	return append(framed, '\n', '\n')
}

func terminalStreamChunk(protocol Protocol) []byte {
	if protocol == ProtocolOpenAI {
		return []byte("data: [DONE]\n\n")
	}
	return nil
}

func normalizeProviderRequest(plan RoutePlan, body []byte, inboundHeaders http.Header) []byte {
	if plan.Upstream != ProtocolCodex {
		return body
	}
	if !json.Valid(body) {
		return body
	}
	body, _ = sjson.SetBytes(body, "model", plan.Model)
	// Codex and the Grok CLI proxy expose Responses as SSE even when the caller
	// wants a final JSON object. Relay performs the final aggregation itself.
	body, _ = sjson.SetBytes(body, "stream", true)
	for _, field := range []string{"previous_response_id", "generate", "prompt_cache_retention", "safety_identifier", "stream_options"} {
		body, _ = sjson.DeleteBytes(body, field)
	}
	return normalizeCodexResponsesLite(body, inboundHeaders)
}

func normalizeCodexResponsesLite(body []byte, headers http.Header) []byte {
	lite := strings.EqualFold(strings.TrimSpace(headers.Get("X-OpenAI-Internal-Codex-Responses-Lite")), "true")
	if !lite {
		value := gjson.GetBytes(body, "client_metadata.ws_request_header_x_openai_internal_codex_responses_lite")
		lite = value.Bool() || strings.EqualFold(strings.TrimSpace(value.String()), "true")
	}
	if lite {
		body, _ = sjson.SetBytes(body, "parallel_tool_calls", false)
	}
	return body
}

func completedSSEPayload(stream []byte) ([]byte, error) {
	var completed []byte
	scanner := bufio.NewScanner(bytes.NewReader(stream))
	buffer := make([]byte, 64<<10)
	scanner.Buffer(buffer, 64<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(line[len("data:"):])
		var event struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(payload, &event) == nil && (event.Type == "response.completed" || event.Type == "response.incomplete") {
			completed = bytes.Clone(payload)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(completed) == 0 {
		return nil, fmt.Errorf("upstream SSE ended without a completed response")
	}
	return completed, nil
}

func copyImmediate(dst io.Writer, src io.Reader, onFirstByte func()) error {
	buffer := make([]byte, 32<<10)
	for {
		n, err := src.Read(buffer)
		if n > 0 {
			if onFirstByte != nil {
				onFirstByte()
				onFirstByte = nil
			}
			if _, writeErr := dst.Write(buffer[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func copyEndToEndHeaders(dst, src http.Header) {
	for key, values := range src {
		switch strings.ToLower(key) {
		case "authorization", "x-api-key", "x-goog-api-key", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding":
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
