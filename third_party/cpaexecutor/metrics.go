package relaybridge

import "time"

// CredentialHealth is an aggregate scheduler snapshot. It contains no IDs or secrets.
type CredentialHealth struct {
	Provider                                               string
	Enabled, Disabled, Unavailable, QuotaExceeded, Cooling int
}

// CredentialHealthSnapshot reads current CPA scheduler state without upstream I/O.
func (r *Runtime) CredentialHealthSnapshot() []CredentialHealth {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	credentials := append([]Credential(nil), r.credentials...)
	r.mu.RUnlock()
	groups := make(map[string]*CredentialHealth)
	for _, credential := range credentials {
		group := groups[credential.Provider]
		if group == nil {
			group = &CredentialHealth{Provider: credential.Provider}
			groups[credential.Provider] = group
		}
		if !credential.Enabled {
			group.Disabled++
			continue
		}
		group.Enabled++
		if status, ok := r.CredentialStatus(credential.ID); ok {
			if status.Unavailable {
				group.Unavailable++
			}
			if status.QuotaExceeded {
				group.QuotaExceeded++
			}
			if status.NextRetryAfter.After(time.Now()) {
				group.Cooling++
			}
		}
	}
	result := make([]CredentialHealth, 0, len(groups))
	for _, group := range groups {
		result = append(result, *group)
	}
	return result
}
