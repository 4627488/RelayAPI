package upstream

import "testing"

func TestDefaultCodexModelsIncludeGPT6Astra(t *testing.T) {
	models := defaultModels("codex")
	if models[0] != "gpt-6-astra" {
		t.Fatalf("default Codex models = %v, want gpt-6-astra first", models)
	}
}
