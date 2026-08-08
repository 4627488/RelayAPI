package app

import (
	"encoding/json"
	"testing"
)

func TestFilterModelCatalogPreservesEnvelopeFormats(t *testing.T) {
	claudeCloaked := "claude-fable-5-dd-" + reverseString("public-model")
	tests := []struct {
		name    string
		payload string
		key     string
		wantID  string
	}{
		{"openai", `{"object":"list","data":[{"id":"public-model"},{"id":"private-model"}]}`, "data", "public-model"},
		{"anthropic", `{"data":[{"id":"` + claudeCloaked + `"},{"id":"claude-private"}],"has_more":true}`, "data", claudeCloaked},
		{"codex", `{"models":[{"id":"public-model"},{"id":"private-model"}]}`, "models", "public-model"},
		{"gemini", `{"models":[{"name":"models/public-model"},{"name":"models/private-model"}]}`, "models", "models/public-model"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := filterModelCatalog([]byte(test.payload), []string{"public-model"})
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(payload, &document); err != nil {
				t.Fatal(err)
			}
			items, _ := document[test.key].([]any)
			if len(items) != 1 {
				t.Fatalf("items = %#v", items)
			}
			item, _ := items[0].(map[string]any)
			if got := catalogModelID(item); got != test.wantID {
				t.Fatalf("id = %q, want %q", got, test.wantID)
			}
		})
	}
}

func TestResolveClaudeCatalogModel(t *testing.T) {
	cloaked := "claude-fable-5-dd-" + reverseString("public-model")
	if got := resolveClaudeCatalogModel(cloaked); got != "public-model" {
		t.Fatalf("resolved = %q", got)
	}
	if got := resolveClaudeCatalogModel(cloaked + "(high)"); got != "public-model(high)" {
		t.Fatalf("resolved thinking model = %q", got)
	}
}
