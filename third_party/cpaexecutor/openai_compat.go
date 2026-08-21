package relaybridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/thinking"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/util"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func newOpenAICompatExecutor(provider string, cfg *internalconfig.Config) cliproxyauth.ProviderExecutor {
	return &openaiCompatExecutor{inner: executor.NewOpenAICompatExecutor(provider, cfg), cfg: cfg}
}

// openaiCompatExecutor keeps official CPA chat/completions behavior and adds
// Relay's Bailian /responses routing plus session-cache headers.
type openaiCompatExecutor struct {
	inner *executor.OpenAICompatExecutor
	cfg   *internalconfig.Config
}

func (e *openaiCompatExecutor) Identifier() string { return e.inner.Identifier() }

func (e *openaiCompatExecutor) PrepareRequest(req *http.Request, auth *cliproxyauth.Auth) error {
	return e.inner.PrepareRequest(req, auth)
}

func (e *openaiCompatExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	return e.inner.HttpRequest(ctx, auth, req)
}

func (e *openaiCompatExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return e.inner.CountTokens(ctx, auth, req, opts)
}

func (e *openaiCompatExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	return e.inner.Refresh(ctx, auth)
}

func (e *openaiCompatExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if !openAICompatUsesResponses(auth, opts) {
		return e.inner.Execute(ctx, auth, req, opts)
	}
	return e.executeResponses(ctx, auth, req, opts)
}

func (e *openaiCompatExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if !openAICompatUsesResponses(auth, opts) {
		return e.inner.ExecuteStream(ctx, auth, req, opts)
	}
	return e.executeResponsesStream(ctx, auth, req, opts)
}

func openAICompatUsesResponses(auth *cliproxyauth.Auth, opts cliproxyexecutor.Options) bool {
	if auth == nil || auth.Attributes == nil || opts.Alt == "responses/compact" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(auth.Attributes["upstream_api"])) {
	case "responses":
		return true
	case "auto":
		return opts.SourceFormat == sdktranslator.FormatOpenAIResponse || opts.SourceFormat == sdktranslator.FormatCodex
	default:
		return false
	}
}

const responseAffinityIDMetadataKey = "response_affinity_id"

func recordResponseAffinityID(metadata map[string]any, payload []byte) {
	if metadata == nil || len(payload) == 0 {
		return
	}
	for _, path := range []string{"response.id", "id"} {
		responseID := strings.TrimSpace(gjson.GetBytes(payload, path).String())
		if responseID != "" {
			metadata[responseAffinityIDMetadataKey] = responseID
			return
		}
	}
}

func applyOpenAICompatProviderHeaders(req *http.Request, auth *cliproxyauth.Auth, endpoint string) {
	if req == nil || auth == nil || auth.Attributes == nil {
		return
	}
	if !strings.EqualFold(strings.TrimSpace(auth.Attributes["vendor"]), "aliyun-bailian") {
		return
	}
	cacheMode := strings.ToLower(strings.TrimSpace(auth.Attributes["cache_mode"]))
	if cacheMode == "" {
		cacheMode = "auto"
	}
	if endpoint == "/responses" && (cacheMode == "auto" || cacheMode == "session") {
		req.Header.Set("x-dashscope-session-cache", "enable")
		return
	}
	req.Header.Del("x-dashscope-session-cache")
}

func resolveOpenAICompatCredentials(auth *cliproxyauth.Auth) (baseURL, apiKey string) {
	if auth == nil || auth.Attributes == nil {
		return "", ""
	}
	return strings.TrimSpace(auth.Attributes["base_url"]), strings.TrimSpace(auth.Attributes["api_key"])
}

func hasOpenAICompatUsage(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	node := gjson.GetBytes(payload, "usage")
	if !node.Exists() {
		node = gjson.GetBytes(payload, "response.usage")
	}
	return node.Exists() && node.IsObject()
}

func observeOpenAICompatUsage(payload []byte) []byte {
	if !hasOpenAICompatUsage(payload) {
		return payload
	}
	if gjson.GetBytes(payload, "usage").Exists() {
		return payload
	}
	if usage := gjson.GetBytes(payload, "response.usage"); usage.Exists() {
		copied, err := sjson.SetRawBytes(payload, "usage", []byte(usage.Raw))
		if err == nil {
			return copied
		}
	}
	return payload
}

func (e *openaiCompatExecutor) executeResponses(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (resp cliproxyexecutor.Response, err error) {
	baseModel := thinking.ParseSuffix(req.Model).ModelName
	reporter := helps.NewExecutorUsageReporter(ctx, e, baseModel, auth)
	defer reporter.TrackFailure(ctx, &err)

	baseURL, apiKey := resolveOpenAICompatCredentials(auth)
	if baseURL == "" {
		err = statusError{code: http.StatusUnauthorized, msg: "missing provider baseURL"}
		return resp, err
	}

	from := opts.SourceFormat
	responseFormat := cliproxyexecutor.ResponseFormatOrSource(opts)
	to := sdktranslator.FromString("openai-response")
	originalPayload := req.Payload
	if len(opts.OriginalRequest) > 0 {
		originalPayload = opts.OriginalRequest
	}
	isCompat := helps.APIKeyModelIsCompat(req)
	originalTranslated := helps.TranslateRequestWithAPIKeyModelCompatibility(ctx, opts.Headers, e.cfg, from, to, baseModel, originalPayload, opts.Stream, isCompat)
	translated := helps.TranslateRequestWithAPIKeyModelCompatibility(ctx, opts.Headers, e.cfg, from, to, baseModel, req.Payload, opts.Stream, isCompat)
	translated, err = helps.ApplyRequestThinking(translated, req, opts, from.String(), to.String(), e.Identifier())
	if err != nil {
		return resp, err
	}
	requestedModel := helps.PayloadRequestedModel(opts, req.Model)
	requestPath := helps.PayloadRequestPath(opts)
	translated = helps.ApplyPayloadConfigWithRequest(e.cfg, baseModel, to.String(), from.String(), "", translated, originalTranslated, requestedModel, requestPath, opts.Headers)
	reporter.SetTranslatedReasoningEffort(translated, to.String())

	endpoint := "/responses"
	url := strings.TrimSuffix(baseURL, "/") + endpoint
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(translated))
	if err != nil {
		return resp, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	httpReq.Header.Set("User-Agent", "cli-proxy-openai-compat")
	var attrs map[string]string
	if auth != nil {
		attrs = auth.Attributes
	}
	util.ApplyCustomHeadersFromAttrs(httpReq, attrs, opts.Headers)
	applyOpenAICompatProviderHeaders(httpReq, auth, endpoint)

	var authID, authLabel, authType, authValue string
	if auth != nil {
		authID = auth.ID
		authLabel = auth.Label
		authType, authValue = auth.AccountInfo()
	}
	helps.RecordAPIRequest(ctx, e.cfg, helps.UpstreamRequestLog{
		URL: url, Method: http.MethodPost, Headers: httpReq.Header.Clone(), Body: translated,
		Provider: e.Identifier(), AuthID: authID, AuthLabel: authLabel, AuthType: authType, AuthValue: authValue,
	})

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	httpClient = reporter.TrackHTTPClient(httpClient)
	httpResp, err := httpClient.Do(httpReq)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return resp, err
	}
	defer httpResp.Body.Close()
	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())
	body, err := io.ReadAll(httpResp.Body)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return resp, err
	}
	helps.AppendAPIResponseChunk(ctx, e.cfg, body)
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		err = statusError{code: httpResp.StatusCode, msg: string(body)}
		return resp, err
	}
	recordResponseAffinityID(opts.Metadata, body)
	reporter.Publish(ctx, helps.ParseOpenAIUsage(observeOpenAICompatUsage(body)))
	reporter.EnsurePublished(ctx)
	var param any
	out := sdktranslator.TranslateNonStream(ctx, to, responseFormat, req.Model, opts.OriginalRequest, translated, body, &param)
	if responseFormat == sdktranslator.FormatOpenAIResponse {
		out = helps.EnsureResponsesUsageDetails(out)
	}
	return cliproxyexecutor.Response{Payload: out, Headers: httpResp.Header.Clone()}, nil
}

func (e *openaiCompatExecutor) executeResponsesStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (_ *cliproxyexecutor.StreamResult, err error) {
	baseModel := thinking.ParseSuffix(req.Model).ModelName
	reporter := helps.NewExecutorUsageReporter(ctx, e, baseModel, auth)
	defer reporter.TrackFailure(ctx, &err)

	baseURL, apiKey := resolveOpenAICompatCredentials(auth)
	if baseURL == "" {
		err = statusError{code: http.StatusUnauthorized, msg: "missing provider baseURL"}
		return nil, err
	}

	from := opts.SourceFormat
	responseFormat := cliproxyexecutor.ResponseFormatOrSource(opts)
	to := sdktranslator.FromString("openai-response")
	originalPayload := req.Payload
	if len(opts.OriginalRequest) > 0 {
		originalPayload = opts.OriginalRequest
	}
	isCompat := helps.APIKeyModelIsCompat(req)
	originalTranslated := helps.TranslateRequestWithAPIKeyModelCompatibility(ctx, opts.Headers, e.cfg, from, to, baseModel, originalPayload, true, isCompat)
	translated := helps.TranslateRequestWithAPIKeyModelCompatibility(ctx, opts.Headers, e.cfg, from, to, baseModel, req.Payload, true, isCompat)
	translated, err = helps.ApplyRequestThinking(translated, req, opts, from.String(), to.String(), e.Identifier())
	if err != nil {
		return nil, err
	}
	requestedModel := helps.PayloadRequestedModel(opts, req.Model)
	requestPath := helps.PayloadRequestPath(opts)
	translated = helps.ApplyPayloadConfigWithRequest(e.cfg, baseModel, to.String(), from.String(), "", translated, originalTranslated, requestedModel, requestPath, opts.Headers)
	translated, _ = sjson.DeleteBytes(translated, "stream_options")
	reporter.SetTranslatedReasoningEffort(translated, to.String())

	endpoint := "/responses"
	url := strings.TrimSuffix(baseURL, "/") + endpoint
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(translated))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	httpReq.Header.Set("User-Agent", "cli-proxy-openai-compat")
	var attrs map[string]string
	if auth != nil {
		attrs = auth.Attributes
	}
	util.ApplyCustomHeadersFromAttrs(httpReq, attrs, opts.Headers)
	applyOpenAICompatProviderHeaders(httpReq, auth, endpoint)
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Cache-Control", "no-cache")

	var authID, authLabel, authType, authValue string
	if auth != nil {
		authID = auth.ID
		authLabel = auth.Label
		authType, authValue = auth.AccountInfo()
	}
	helps.RecordAPIRequest(ctx, e.cfg, helps.UpstreamRequestLog{
		URL: url, Method: http.MethodPost, Headers: httpReq.Header.Clone(), Body: translated,
		Provider: e.Identifier(), AuthID: authID, AuthLabel: authLabel, AuthType: authType, AuthValue: authValue,
	})

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	httpClient = reporter.TrackHTTPClient(httpClient)
	httpResp, err := httpClient.Do(httpReq)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return nil, err
	}
	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		b, _ := io.ReadAll(httpResp.Body)
		_ = httpResp.Body.Close()
		helps.AppendAPIResponseChunk(ctx, e.cfg, b)
		err = statusError{code: httpResp.StatusCode, msg: string(b)}
		return nil, err
	}

	out := make(chan cliproxyexecutor.StreamChunk)
	go func() {
		defer close(out)
		defer httpResp.Body.Close()
		scanner := bufio.NewScanner(httpResp.Body)
		scanner.Buffer(nil, 52_428_800)
		claudeInputTokens := helps.NewClaudeInputTokenState(from, to, responseFormat, originalPayload)
		var param any
		var streamUsage helps.StreamUsageBuffer
		var seenDone bool
		var streamFailed bool
		var streamAborted bool
		var upstreamEvent string
		var frameData [][]byte
		defer streamUsage.Publish(ctx, reporter)

		publishStreamError := func(streamErr statusError) {
			helps.RecordAPIResponseError(ctx, e.cfg, streamErr)
			reporter.PublishFailure(ctx, streamErr)
			select {
			case out <- cliproxyexecutor.StreamChunk{Err: streamErr}:
			case <-ctx.Done():
			}
			streamFailed = true
		}

		processFrame := func() bool {
			eventName := upstreamEvent
			upstreamEvent = ""
			dataLines := frameData
			frameData = nil
			if len(dataLines) == 0 {
				return false
			}
			dataPayload := bytes.TrimSpace(bytes.Join(dataLines, []byte("\n")))
			isDone := bytes.Equal(dataPayload, []byte("[DONE]"))
			if !isDone && !json.Valid(dataPayload) {
				publishStreamError(statusError{code: http.StatusBadGateway, msg: "upstream stream ended with incomplete SSE data frame"})
				return true
			}
			if !isDone {
				recordResponseAffinityID(opts.Metadata, dataPayload)
				streamUsage.ObserveOpenAIStream(append([]byte("data: "), observeOpenAICompatUsage(dataPayload)...))
			}
			if !isDone && (strings.EqualFold(eventName, "error") || strings.EqualFold(gjson.GetBytes(dataPayload, "type").String(), "error") || strings.EqualFold(gjson.GetBytes(dataPayload, "type").String(), "response.failed")) {
				publishStreamError(statusError{code: http.StatusBadGateway, msg: string(dataPayload)})
				return true
			}
			streamLine := append([]byte("data: "), dataPayload...)
			chunks := helps.TranslateStreamWithClaudeInputTokens(ctx, to, responseFormat, req.Model, opts.OriginalRequest, translated, streamLine, &param, claudeInputTokens)
			for i := range chunks {
				select {
				case out <- cliproxyexecutor.StreamChunk{Payload: chunks[i]}:
				case <-ctx.Done():
					streamAborted = true
					return true
				}
			}
			if isDone {
				seenDone = true
				return true
			}
			return false
		}

		for scanner.Scan() {
			line := scanner.Bytes()
			helps.AppendAPIResponseChunk(ctx, e.cfg, line)
			trimmedLine := bytes.TrimSpace(line)
			if len(trimmedLine) == 0 {
				if processFrame() {
					break
				}
				continue
			}
			if bytes.HasPrefix(trimmedLine, []byte("data:")) {
				frameData = append(frameData, bytes.Clone(bytes.TrimSpace(trimmedLine[len("data:"):])))
				continue
			}
			if bytes.HasPrefix(trimmedLine, []byte("event:")) {
				upstreamEvent = strings.TrimSpace(string(trimmedLine[len("event:"):]))
				continue
			}
			if bytes.HasPrefix(trimmedLine, []byte(":")) || bytes.HasPrefix(trimmedLine, []byte("id:")) || bytes.HasPrefix(trimmedLine, []byte("retry:")) {
				continue
			}
		}
		if errScan := scanner.Err(); errScan == nil && !seenDone && !streamFailed && !streamAborted && len(frameData) > 0 {
			_ = processFrame()
		} else if errScan != nil {
			helps.RecordAPIResponseError(ctx, e.cfg, errScan)
			reporter.PublishFailure(ctx, errScan)
			select {
			case out <- cliproxyexecutor.StreamChunk{Err: errScan}:
			case <-ctx.Done():
			}
		} else if !seenDone && !streamFailed && !streamAborted && responseFormat == sdktranslator.FormatOpenAIResponse {
			streamErr := statusError{code: http.StatusBadGateway, msg: "upstream stream closed before [DONE]"}
			helps.RecordAPIResponseError(ctx, e.cfg, streamErr)
			reporter.PublishFailure(ctx, streamErr)
			select {
			case out <- cliproxyexecutor.StreamChunk{Err: streamErr}:
			case <-ctx.Done():
			}
		}
		streamUsage.Publish(ctx, reporter)
		reporter.EnsurePublished(ctx)
	}()
	return &cliproxyexecutor.StreamResult{Headers: httpResp.Header.Clone(), Chunks: out}, nil
}

type statusError struct {
	code       int
	msg        string
	retryAfter *time.Duration
}

func (e statusError) Error() string {
	if e.msg != "" {
		return e.msg
	}
	return fmt.Sprintf("status %d", e.code)
}

func (e statusError) StatusCode() int            { return e.code }
func (e statusError) RetryAfter() *time.Duration { return e.retryAfter }
