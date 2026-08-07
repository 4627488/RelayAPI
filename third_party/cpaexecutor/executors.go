// Package relaybridge exposes CPA's provider executors without starting its
// proxy service. Its module path deliberately lives below CPA's module path so
// Go permits this small adapter to import CPA's internal executor package.
package relaybridge

import (
	"context"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/cache"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// WithRoundTripper injects Relay's pooled transport into CPA's executor
// context. CPA's executor helpers intentionally recognize this context key.
func WithRoundTripper(ctx context.Context, transport http.RoundTripper) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if transport == nil {
		return ctx
	}
	return context.WithValue(ctx, "cliproxy.roundtripper", transport)
}

// Codex returns CPA's complete HTTP/WebSocket Codex compatibility executor.
func Codex(cfg *config.Config) cliproxyauth.ProviderExecutor {
	return executor.NewCodexAutoExecutor(cfg)
}

// XAI returns CPA's complete HTTP/WebSocket Grok compatibility executor.
func XAI(cfg *config.Config) cliproxyauth.ProviderExecutor {
	return executor.NewXAIAutoExecutor(cfg)
}

// CloseExecutionSession releases an executor's connection-scoped resources.
func CloseExecutionSession(exec cliproxyauth.ProviderExecutor, sessionID string) {
	if closer, ok := exec.(interface{ CloseExecutionSession(string) }); ok {
		closer.CloseExecutionSession(sessionID)
	}
}

// UpstreamDisconnectChan reports an idle connection failure for a retained
// upstream WebSocket session.
func UpstreamDisconnectChan(exec cliproxyauth.ProviderExecutor, sessionID string) <-chan error {
	if subscriber, ok := exec.(interface{ UpstreamDisconnectChan(string) <-chan error }); ok {
		return subscriber.UpstreamDisconnectChan(sessionID)
	}
	return nil
}

// ClearReasoningCaches drops CPA's process-local replay caches. Relay calls
// this only under heap pressure; normal TTL and LRU behavior remains intact.
func ClearReasoningCaches() {
	cache.ClearCodexReasoningReplayCache()
	cache.ClearXAIReasoningReplayCache()
}

// CloseAllExecutionSessions releases every retained upstream WebSocket.
func CloseAllExecutionSessions(exec cliproxyauth.ProviderExecutor) {
	CloseExecutionSession(exec, cliproxyauth.CloseAllExecutionSessionsID)
}
