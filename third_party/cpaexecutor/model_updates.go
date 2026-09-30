package relaybridge

import (
	"context"
	"sync"

	// The public model registry hook observes client registrations, not changes
	// to CPA's static provider catalogs. Until the SDK exposes catalog refreshes,
	// this callback is needed to rebuild database-backed credential grants.
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

var modelCatalogUpdates struct {
	sync.Mutex
	owner *Runtime
}

// StartModelCatalogUpdates follows CPA's remote provider catalog and notifies
// Relay when a changed catalog needs credential routes and grants rebuilt.
func (r *Runtime) StartModelCatalogUpdates(onChange func([]string)) {
	if r == nil {
		return
	}
	modelCatalogUpdates.Lock()
	modelCatalogUpdates.owner = r
	registry.SetModelRefreshCallback(func(providers []string) {
		if len(providers) == 0 {
			return
		}
		r.modelUpdateMu.Lock()
		defer r.modelUpdateMu.Unlock()
		r.mu.RLock()
		closed := r.closed
		r.mu.RUnlock()
		if !closed && onChange != nil {
			onChange(providers)
		}
	})
	modelCatalogUpdates.Unlock()
	// CPA's updater is process-wide and starts only once; a replacement Runtime
	// installs its own callback while continuing to use the refreshed catalog.
	registry.StartModelsUpdater(context.Background())
}

func (r *Runtime) stopModelCatalogUpdates() {
	modelCatalogUpdates.Lock()
	if modelCatalogUpdates.owner == r {
		modelCatalogUpdates.owner = nil
		registry.SetModelRefreshCallback(nil)
	}
	modelCatalogUpdates.Unlock()
	r.modelUpdateMu.Lock()
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	r.modelUpdateMu.Unlock()
}
