package relaybridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
)

type cursorExecutor struct {
	*openaiCompatExecutor
	pool *cursorRuntimePool
}

func newCursorExecutor(cfg *sdkconfig.Config, pool *cursorRuntimePool) cliproxyauth.ProviderExecutor {
	return &cursorExecutor{openaiCompatExecutor: newOpenAICompatExecutor("cursor", cfg).(*openaiCompatExecutor), pool: pool}
}

func (e *cursorExecutor) prepare(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	if auth == nil {
		return nil, fmt.Errorf("Cursor credential is missing")
	}
	endpoint, err := e.pool.endpoint(ctx, auth.ProxyURL)
	if err != nil {
		return nil, statusError{code: http.StatusServiceUnavailable, msg: err.Error()}
	}
	copy := auth.Clone()
	copy.Attributes["base_url"] = endpoint
	copy.Attributes["upstream_api"] = "responses"
	// Account egress applies inside the SDK; loopback must always be direct.
	copy.ProxyURL = "direct"
	return copy, nil
}

func (e *cursorExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, request *http.Request) (*http.Response, error) {
	if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/models") {
		return nil, statusError{code: http.StatusBadRequest, msg: "Cursor only supports model discovery through HttpRequest"}
	}
	prepared, err := e.prepare(ctx, auth)
	if err != nil {
		return nil, err
	}
	copy := request.Clone(ctx)
	copy.URL, err = url.Parse(prepared.Attributes["base_url"] + "/models")
	if err != nil {
		return nil, err
	}
	copy.Host = ""
	return e.openaiCompatExecutor.HttpRequest(ctx, prepared, copy)
}

func (e *cursorExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if err := validateCursorRequest(opts); err != nil {
		return cliproxyexecutor.Response{}, err
	}
	prepared, err := e.prepare(ctx, auth)
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	return e.openaiCompatExecutor.Execute(ctx, prepared, req, cursorSessionOptions(auth, req, opts))
}

func (e *cursorExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if err := validateCursorRequest(opts); err != nil {
		return nil, err
	}
	prepared, err := e.prepare(ctx, auth)
	if err != nil {
		return nil, err
	}
	return e.openaiCompatExecutor.ExecuteStream(ctx, prepared, req, cursorSessionOptions(auth, req, opts))
}

func validateCursorRequest(opts cliproxyexecutor.Options) error {
	if opts.Alt != "" {
		return statusError{code: http.StatusBadRequest, msg: "Cursor SDK does not support this endpoint (including Responses compact)"}
	}
	switch opts.SourceFormat {
	case sdktranslator.FormatOpenAI, sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, sdktranslator.FormatClaude:
	default:
		return statusError{code: http.StatusBadRequest, msg: "Cursor supports Responses, Chat Completions and Messages requests"}
	}
	path := helps.PayloadRequestPath(opts)
	for _, part := range []string{"/images", "/videos", "/realtime", "/alpha/search"} {
		if strings.Contains(path, part) {
			return statusError{code: http.StatusBadRequest, msg: "Cursor SDK does not support this endpoint"}
		}
	}
	return nil
}

func applyCursorHeaders(request *http.Request, auth *cliproxyauth.Auth, source http.Header) {
	if auth == nil || auth.Provider != "cursor" {
		return
	}
	for _, name := range cursorSessionHeaders {
		request.Header.Del(name)
	}
	if session := source.Get("X-Relay-Cursor-Session"); session != "" {
		request.Header.Set("Session-ID", session)
	}
	if agent := source.Get("User-Agent"); agent != "" {
		request.Header.Set("User-Agent", agent)
	}
}

func cursorSessionOptions(auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) cliproxyexecutor.Options {
	opts.Headers = opts.Headers.Clone()
	if opts.Headers == nil {
		opts.Headers = make(http.Header)
	}
	opts.Headers.Del("X-Relay-Cursor-Session")
	session := ""
	for _, name := range cursorSessionHeaders {
		if session == "" {
			session = strings.TrimSpace(opts.Headers.Get(name))
		}
	}
	if session == "" {
		session = strings.TrimSpace(gjson.GetBytes(req.Payload, "prompt_cache_key").String())
	}
	if session != "" {
		// Equal client session IDs belonging to different Relay keys must never
		// share a warm SDK agent, even when they use the same upstream key.
		digest := sha256.Sum256([]byte(auth.ID + "\x00" + opts.Headers.Get("X-Relay-Principal") + "\x00" + session))
		opts.Headers.Set("X-Relay-Cursor-Session", hex.EncodeToString(digest[:]))
	}
	return opts
}

var cursorSessionHeaders = []string{"session-id", "session_id", "conversation-id", "conversation_id", "thread-id", "thread_id", "x-session-affinity", "x-opencode-session-id", "x-opencode-session", "x-client-request-id"}
