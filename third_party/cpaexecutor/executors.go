package relaybridge

import (
	"github.com/router-for-me/CLIProxyAPI/v7/internal/cache"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// ClearReasoningCaches drops CPA's process-local replay caches. Relay calls
// this only under heap pressure; normal TTL and LRU behavior remains intact.
func ClearReasoningCaches() {
	cache.ClearCodexReasoningReplayCache()
	cache.ClearXAIReasoningReplayCache()
}

func CloseAllExecutionSessions(exec cliproxyauth.ProviderExecutor) {
	if closer, ok := exec.(interface{ CloseExecutionSession(string) }); ok {
		closer.CloseExecutionSession(cliproxyauth.CloseAllExecutionSessionsID)
	}
}
