package relaybridge

import (
	"strings"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// NativeClaudeCapabilities requires agreement across every registered route
// for this public ID. Mixed-provider aliases must not inherit Claude features.
func (r *Runtime) NativeClaudeCapabilities(model string) (canonical string, toolSearch bool, ok bool) {
	if r == nil {
		return "", false, false
	}
	type candidate struct{ id, model string }
	var candidates []candidate
	r.mu.RLock()
	for id, route := range r.routes {
		for public, target := range route.models {
			if !strings.EqualFold(public, model) {
				continue
			}
			if route.provider != "claude" || (canonical != "" && !strings.EqualFold(canonical, target.upstream)) {
				r.mu.RUnlock()
				return "", false, false
			}
			canonical = target.upstream
			candidates = append(candidates, candidate{id, canonical})
		}
	}
	r.mu.RUnlock()
	if len(candidates) == 0 || canonical == "" {
		return "", false, false
	}
	toolSearch = true
	exec, exists := r.manager.Executor("claude")
	support, supported := exec.(coreauth.NativeToolSearchSupport)
	for _, route := range candidates {
		auth, found := r.manager.GetByID(route.id)
		if !exists || !supported || !found || !support.SupportsNativeToolSearch(auth, route.model) {
			toolSearch = false
		}
	}
	return canonical, toolSearch, true
}
