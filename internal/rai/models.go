package rai

import "slices"

// DefaultModelCandidates returns the initial site preference order.
func DefaultModelCandidates() []string {
	return []string{"gpt-5.6-sol", "grok-4.6"}
}

// SelectDefaultModel only selects a candidate available to this API key.
func SelectDefaultModel(models, candidates []string) string {
	for _, candidate := range candidates {
		if slices.Contains(models, candidate) {
			return candidate
		}
	}
	return ""
}
