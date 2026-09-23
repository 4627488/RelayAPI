package upstream

import (
	"slices"
	"testing"
)

func TestDefaultModelsIncludeLatestCPAModels(t *testing.T) {
	for provider, want := range map[string][]string{
		"codex": {"gpt-6-sol", "gpt-6-luna", "gpt-6-astra"},
		"xai":   {"grok-4.7", "grok-4.7-build-fast"},
	} {
		models := defaultModels(provider)
		for _, model := range want {
			if !slices.Contains(models, model) {
				t.Errorf("default %s models = %v, missing %s", provider, models, model)
			}
		}
	}
}
