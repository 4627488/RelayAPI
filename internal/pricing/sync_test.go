package pricing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchModelsDevDeduplicatesQualifiedModelIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"openrouter": {
				"id": "openrouter",
				"models": {
					"anthropic/claude-test": {
						"id": "anthropic/claude-test",
						"cost": {"input": 9, "output": 18}
					},
					"shared/model": {
						"id": "shared/model",
						"cost": {"input": 7, "output": 14}
					}
				}
			},
			"kilo": {
				"id": "kilo",
				"models": {
					"shared/model": {
						"id": "shared/model",
						"cost": {"input": 6, "output": 12}
					}
				}
			},
			"anthropic": {
				"id": "anthropic",
				"models": {
					"claude-test": {
						"id": "claude-test",
						"cost": {"input": 1, "output": 2}
					}
				}
			},
			"provider-a": {"id": "provider-a", "models": {
				"model-1": {"id": "model-1", "cost": {"input": 1, "output": 2}},
				"model-2": {"id": "model-2", "cost": {"input": 1, "output": 2}},
				"model-3": {"id": "model-3", "cost": {"input": 1, "output": 2}},
				"model-4": {"id": "model-4", "cost": {"input": 1, "output": 2}},
				"model-5": {"id": "model-5", "cost": {"input": 1, "output": 2}},
				"model-6": {"id": "model-6", "cost": {"input": 1, "output": 2}},
				"model-7": {"id": "model-7", "cost": {"input": 1, "output": 2}},
				"model-8": {"id": "model-8", "cost": {"input": 1, "output": 2}}
			}}
		}`))
	}))
	defer server.Close()

	result, err := FetchModelsDev(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("FetchModelsDev() error = %v", err)
	}

	byModel := make(map[string]CatalogEntry, len(result.Entries))
	for _, entry := range result.Entries {
		if _, exists := byModel[entry.Model]; exists {
			t.Fatalf("duplicate catalog model %q", entry.Model)
		}
		byModel[entry.Model] = entry
	}
	if got := byModel["anthropic/claude-test"]; got.SourceModelID != "anthropic/claude-test" ||
		got.InputNanoUSDPerToken != 1000 {
		t.Fatalf("direct provider was not preferred: %+v", got)
	}
	if got := byModel["shared/model"]; got.SourceModelID != "kilo/shared/model" ||
		got.InputNanoUSDPerToken != 6000 {
		t.Fatalf("stable provider tie-break was not applied: %+v", got)
	}
}
