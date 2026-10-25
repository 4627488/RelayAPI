package app

import (
	"strings"

	"github.com/4627488/RelayAPI/internal/rai"
	"github.com/4627488/RelayAPI/internal/store"
)

// The embedded CPA Responses handler adapts downstream WebSocket turns onto
// each executor's stream, including Chat-only upstreams. Transport capability
// belongs to this gateway adapter, not to a models.dev model fact.
func (a *App) raiCodexCapabilities(key store.KeyContext, models []string) rai.CodexCapabilities {
	c := rai.CodexCapabilities{Version: 1}
	if len(models) == 0 || a.nativeRuntime == nil {
		return c
	}
	embedded := a.inferenceCPA() != nil
	c.WebSockets = a.upstreamWebSockets()
	c.RemoteCompaction = embedded
	c.StandaloneWebSearch = embedded
	for _, model := range models {
		target := resolveAPIKeyModel(model, key.ModelAliases).Model
		provider, ok := a.nativeRuntime.ModelProvider(target)
		if !ok {
			c.WebSockets = false
			c.RemoteCompaction = false
			c.StandaloneWebSearch = false
			continue
		}
		// Native fallback does not have CPA's WS-to-HTTP adaptation.
		if !embedded && provider != "codex" && provider != "xai" {
			c.WebSockets = false
		}
		switch strings.ToLower(provider) {
		case "codex", "xai", "kimi", "openai", "openai-compatible", "openai-compatibility", "cursor", "aliyun-bailian":
		default:
			c.RemoteCompaction = false
		}
		// Only Codex owns the standalone search endpoint. Inline/model-hosted
		// search remains available through the ordinary Responses tool contract.
		if provider != "codex" {
			c.StandaloneWebSearch = false
		}
		if capability, ok := a.capabilityIndex().Lookup(target); ok && capability.PreferWebSockets != nil && !*capability.PreferWebSockets {
			c.WebSockets = false
		}
	}
	return c
}
