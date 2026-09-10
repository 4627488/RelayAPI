package relaybridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// RefreshCredential uses CPA's shared refresh lifecycle and always returns the
// latest runtime document, including when no refresh is needed. Quota probes
// must not fall back to an older database snapshot after CPA rotates a token.
//
// A non-forced call returns the current in-memory credential. A forced call
// goes through Manager.ForceRefreshAuth so it shares CPA's per-credential lock,
// persist hook, and unauthorized/backoff updates.
func (r *Runtime) RefreshCredential(ctx context.Context, id string, force bool) ([]byte, bool, error) {
	if r == nil || r.manager == nil {
		return nil, false, fmt.Errorf("embedded CPA runtime is not available")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, false, fmt.Errorf("CPA credential requires an ID")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !force {
		auth, ok := r.manager.GetByID(id)
		if !ok || auth == nil {
			return nil, false, fmt.Errorf("CPA credential %q is not registered", id)
		}
		document, err := encodeCredentialMetadata(auth.Metadata)
		return document, false, err
	}
	auth, err := r.manager.ForceRefreshAuth(ctx, id)
	if err != nil {
		return nil, false, err
	}
	document, err := encodeCredentialMetadata(auth.Metadata)
	if err != nil {
		return nil, false, err
	}
	return document, true, nil
}

func encodeCredentialMetadata(metadata map[string]any) ([]byte, error) {
	document, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("encode CPA credential: %w", err)
	}
	return document, nil
}
