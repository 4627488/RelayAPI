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

// Prefer the gateway's explicit display mapping while retaining every legacy
// callable ID in Session.Models for saved profiles and older clients.
func (s Session) displayModel(model string) string {
	if id := s.ModelIDs[model]; id != "" && contains(s.Models, id) {
		return id
	}
	return model
}

func (s Session) displayModels() []string {
	result := make([]string, 0, len(s.Models))
	seen := map[string]bool{}
	for _, model := range s.Models {
		id := s.displayModel(model)
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result
}
