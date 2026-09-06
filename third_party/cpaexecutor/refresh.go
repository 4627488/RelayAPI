package relaybridge

import (
	"context"
	"encoding/json"
	"fmt"
)

// RefreshCredential uses CPA's shared refresh lifecycle and always returns the
// latest runtime document, including when no refresh is needed. Quota probes
// must not fall back to an older database snapshot after CPA rotates a token.
func (r *Runtime) RefreshCredential(ctx context.Context, id string, force bool) ([]byte, bool, error) {
	if r == nil || r.manager == nil {
		return nil, false, fmt.Errorf("embedded CPA runtime is not available")
	}
	auth, refreshed, err := r.manager.RefreshCredential(ctx, id, force)
	if err != nil {
		return nil, false, err
	}
	document, err := json.Marshal(auth.Metadata)
	if err != nil {
		return nil, false, fmt.Errorf("encode CPA credential: %w", err)
	}
	return document, refreshed, nil
}
