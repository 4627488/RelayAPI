package dataplane

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	relaybridge "github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// CompatibilityExecutors embeds CPA's provider-specific compatibility layer
// only. Relay remains responsible for selecting the route and credential.
type CompatibilityExecutors struct {
	codex cliproxyauth.ProviderExecutor
	xai   cliproxyauth.ProviderExecutor
}

func NewCompatibilityExecutors() *CompatibilityExecutors {
	cfg := &config.Config{}
	return &CompatibilityExecutors{codex: relaybridge.Codex(cfg), xai: relaybridge.XAI(cfg)}
}

func (e *CompatibilityExecutors) provider(name string) cliproxyauth.ProviderExecutor {
	if e == nil {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "codex":
		return e.codex
	case "xai", "grok":
		return e.xai
	default:
		return nil
	}
}

func (e *Engine) doCompatibilityExecutor(ctx context.Context, plan RoutePlan, credential Credential,
	inboundHeaders http.Header, body []byte) (*Exchange, bool, error) {
	exec := e.Executors.provider(plan.Provider)
	if exec == nil {
		return nil, false, nil
	}
	transport, err := e.Transports.RoundTripper(credential.ProxyURL)
	if err != nil {
		return nil, true, err
	}
	ctx = relaybridge.WithRoundTripper(ctx, transport)
	auth := executorAuth(plan, credential, false)
	request := cliproxyexecutor.Request{
		Model: plan.Model, Payload: bytes.Clone(body), Format: format(plan.Inbound),
		Metadata: map[string]any{
			cliproxyexecutor.RequestedModelMetadataKey: plan.Model,
			cliproxyexecutor.RequestPathMetadataKey:    inboundPath(plan.Inbound),
		},
	}
	options := cliproxyexecutor.Options{
		Stream: plan.Stream, Headers: inboundHeaders.Clone(), OriginalRequest: bytes.Clone(body),
		SourceFormat: format(plan.Inbound), ResponseFormat: format(plan.Inbound),
		Metadata: request.Metadata,
	}

	response := &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header)}
	if plan.Stream {
		stream, streamErr := exec.ExecuteStream(ctx, auth, request, options)
		if streamErr != nil {
			return nil, true, streamErr
		}
		if stream == nil || stream.Chunks == nil {
			return nil, true, fmt.Errorf("%s executor returned no stream", plan.Provider)
		}
		response.Header = stream.Headers.Clone()
		response.Body = &executorStreamBody{ctx: ctx, chunks: stream.Chunks}
	} else {
		result, executeErr := exec.Execute(ctx, auth, request, options)
		if executeErr != nil {
			return nil, true, executeErr
		}
		response.Header = result.Headers.Clone()
		response.Body = io.NopCloser(bytes.NewReader(result.Payload))
		response.ContentLength = int64(len(result.Payload))
	}
	if response.Header == nil {
		response.Header = make(http.Header)
	}
	response.Header.Set("Content-Type", executorContentType(plan.Inbound, plan.Stream))
	logRequest := &http.Request{Method: http.MethodPost, URL: cloneURL(plan.Endpoint), Header: inboundHeaders.Clone()}
	return &Exchange{
		Plan: plan, OriginalRequest: bytes.Clone(body), TranslatedRequest: bytes.Clone(body),
		Request: logRequest, Response: response, ExecutorManaged: true,
	}, true, nil
}

func executorAuth(plan RoutePlan, credential Credential, websocket bool) *cliproxyauth.Auth {
	baseURL := executorBaseURL(plan.Endpoint)
	provider := strings.ToLower(strings.TrimSpace(plan.Provider))
	if provider == "grok" {
		provider = "xai"
	}
	attributes := map[string]string{"base_url": baseURL, "websockets": "true"}
	metadata := map[string]any{"base_url": baseURL, "websockets": true}
	if credential.APIKey != "" {
		attributes["api_key"] = credential.APIKey
	}
	if credential.AccessToken != "" {
		metadata["access_token"] = credential.AccessToken
		metadata["auth_kind"] = "oauth"
		attributes["auth_kind"] = "oauth"
	}
	if credential.AccountID != "" {
		metadata["account_id"] = credential.AccountID
	}
	for name, values := range credential.ExtraHeaders {
		if len(values) > 0 {
			attributes["header:"+name] = values[len(values)-1]
		}
	}
	proxyURL := ""
	if websocket {
		proxyURL = credential.ProxyURL
	}
	return &cliproxyauth.Auth{
		ID: credential.ID, Label: credential.Name, Provider: provider, ProxyURL: proxyURL,
		Attributes: attributes, Metadata: metadata,
	}
}

// ExecuteWebSocketTurn runs one downstream Responses WebSocket turn through
// CPA's full Codex/XAI auto executor. The session ID pins the retained upstream
// connection; Relay still supplies the already selected route and credential.
func (e *Engine) ExecuteWebSocketTurn(ctx context.Context, sessionID string, plan RoutePlan, credential Credential,
	inboundHeaders http.Header, body []byte, requireExisting bool) (*cliproxyexecutor.StreamResult, error) {
	exec := e.Executors.provider(plan.Provider)
	if exec == nil {
		return nil, fmt.Errorf("provider %q has no WebSocket compatibility executor", plan.Provider)
	}
	ctx = cliproxyexecutor.WithDownstreamWebsocket(ctx)
	if requireExisting {
		ctx = cliproxyexecutor.WithRequiredUpstreamWebsocket(ctx)
	}
	metadata := map[string]any{
		cliproxyexecutor.RequestedModelMetadataKey:   plan.Model,
		cliproxyexecutor.RequestPathMetadataKey:      "/v1/responses",
		cliproxyexecutor.ExecutionSessionMetadataKey: sessionID,
	}
	request := cliproxyexecutor.Request{Model: plan.Model, Payload: bytes.Clone(body), Format: format(plan.Inbound), Metadata: metadata}
	options := cliproxyexecutor.Options{
		Stream: true, Headers: inboundHeaders.Clone(), OriginalRequest: bytes.Clone(body),
		SourceFormat: format(plan.Inbound), ResponseFormat: format(plan.Inbound), Metadata: metadata,
	}
	return exec.ExecuteStream(ctx, executorAuth(plan, credential, true), request, options)
}

func (e *Engine) CloseWebSocketSession(provider, sessionID string) {
	if e == nil || e.Executors == nil {
		return
	}
	relaybridge.CloseExecutionSession(e.Executors.provider(provider), sessionID)
}

func (e *Engine) WebSocketDisconnect(provider, sessionID string) <-chan error {
	if e == nil || e.Executors == nil {
		return nil
	}
	return relaybridge.UpstreamDisconnectChan(e.Executors.provider(provider), sessionID)
}

func (e *Engine) ClearCompatibilityCaches() {
	relaybridge.ClearReasoningCaches()
}

func (e *Engine) CloseCompatibilitySessions() {
	if e == nil || e.Executors == nil {
		return
	}
	relaybridge.CloseAllExecutionSessions(e.Executors.codex)
	relaybridge.CloseAllExecutionSessions(e.Executors.xai)
}

func executorBaseURL(endpoint *url.URL) string {
	if endpoint == nil {
		return ""
	}
	base := *endpoint
	clean := strings.TrimRight(base.Path, "/")
	if strings.HasSuffix(strings.ToLower(clean), "/responses") {
		clean = clean[:len(clean)-len("/responses")]
	}
	base.Path = clean
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return strings.TrimRight(base.String(), "/")
}

func inboundPath(protocol Protocol) string {
	switch protocol {
	case ProtocolClaude:
		return "/v1/messages"
	case ProtocolOpenAI:
		return "/v1/chat/completions"
	default:
		return "/v1/responses"
	}
}

func executorContentType(protocol Protocol, stream bool) string {
	if !stream {
		return "application/json"
	}
	if protocol == ProtocolGemini {
		return "application/json"
	}
	return "text/event-stream"
}

type executorStreamBody struct {
	ctx    context.Context
	chunks <-chan cliproxyexecutor.StreamChunk
	buffer []byte
	err    error
}

func (b *executorStreamBody) Read(destination []byte) (int, error) {
	for len(b.buffer) == 0 && b.err == nil {
		select {
		case <-b.ctx.Done():
			b.err = b.ctx.Err()
		case chunk, ok := <-b.chunks:
			if !ok {
				b.err = io.EOF
				break
			}
			if chunk.Err != nil {
				b.err = chunk.Err
				break
			}
			b.buffer = chunk.Payload
		}
	}
	if len(b.buffer) > 0 {
		n := copy(destination, b.buffer)
		b.buffer = b.buffer[n:]
		return n, nil
	}
	return 0, b.err
}

func (b *executorStreamBody) Close() error { return nil }
