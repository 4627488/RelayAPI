package app

import (
	"github.com/4627488/RelayAPI/internal/rai"
	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) raiCodexCapabilities(key store.KeyContext, models []string) rai.CodexCapabilities {
	c := rai.CodexCapabilities{Version: 1}
	if a.nativeRuntime == nil || len(models) == 0 {
		return c
	}
	c.WebSockets = a.upstreamWebSockets()
	c.RemoteCompaction = true
	for _, model := range models {
		target := resolveAPIKeyModel(model, key.ModelAliases).Model
		if _, ok := a.nativeRuntime.ModelProvider(target); !ok {
			c.WebSockets = false
			c.RemoteCompaction = false
		}
		if capability, ok := a.capabilityIndex().Lookup(target); ok && capability.PreferWebSockets != nil && !*capability.PreferWebSockets {
			c.WebSockets = false
		}
	}
	return c
}
