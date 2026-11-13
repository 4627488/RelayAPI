package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestResponsesCatalogAdvertisesMagpieCapabilitiesAndEffectivePrices(t *testing.T) {
	index := pricing.NewCapabilityIndex("test", []pricing.Capability{{
		ID: "native", Source: pricing.SourceAdmin, Name: "Native Model", Context: 1000000, MaxOutput: 128000,
		InputModalities: []string{"text", "image"}, Reasoning: true,
		ReasoningOptions: []pricing.ReasoningOption{{Type: "effort", Values: []string{"low", "high"}}},
	}})
	key := store.KeyContext{APIKey: store.APIKey{ModelAliases: []store.APIKeyModelAlias{{Alias: "friendly", Model: "native"}}}}
	lookups := []string{}
	payload, err := enrichResponsesCatalog([]byte(`{"object":"list","data":[{"id":"native"},{"id":"friendly"},{"id":"unknown"}]}`), index, key, func(model string) (store.ResolvedPrice, error) {
		lookups = append(lookups, model)
		if model != "native" {
			return store.ResolvedPrice{}, store.ErrNotFound
		}
		return store.ResolvedPrice{Price: pricing.Price{
			InputNanoUSDPerToken: 2500, OutputNanoUSDPerToken: 10000, CachedInputNanoUSDPerToken: 250,
			Tiers: []pricing.Tier{{Above: 272000, InputNanoUSDPerToken: 5000, OutputNanoUSDPerToken: 15000, CachedInputNanoUSDPerToken: 500}},
		}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var document struct{ Data []map[string]any }
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	for i, item := range document.Data[:2] {
		name := []string{"Native Model", "friendly"}[i]
		if item["context_length"] != float64(1000000) || item["max_output_tokens"] != float64(128000) || item["display_name"] != name {
			t.Fatalf("missing capabilities: %s", payload)
		}
		if len(item["supported_reasoning_levels"].([]any)) != 2 || len(item["modalities"].(map[string]any)["input"].([]any)) != 2 {
			t.Fatalf("missing reasoning or vision: %s", payload)
		}
		price := item["magpie_price"].(map[string]any)
		if price["input"] != 2.5 || price["output"] != float64(10) || price["cache_read"] != .25 {
			t.Fatalf("wrong USD/million conversion: %s", payload)
		}
		if price["tiers"].([]any)[0].(map[string]any)["above"] != float64(272000) {
			t.Fatalf("lost long-context tier: %s", payload)
		}
	}
	unknown := document.Data[2]
	if unknown["magpie_price"] != nil || unknown["context_length"] != nil {
		t.Fatalf("unknown facts were guessed: %s", payload)
	}
	if lookups[1] != "native" || unknown["native_endpoints"].([]any)[0] != "/responses" {
		t.Fatalf("incorrect alias price or protocol: %s", payload)
	}
}

func TestServeStandardModelCatalogIncludesAuthorizedCapabilities(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{"native", "private"}, Document: []byte(`{"type":"codex","access_token":"test"}`)})
	app.setCapabilities(pricing.NewCapabilityIndex("test", []pricing.Capability{{ID: "native", Source: pricing.SourceAdmin, Context: 1000000, MaxOutput: 128000, InputModalities: []string{"text"}}}))
	key := store.KeyContext{TenantModels: []string{"native"}, APIKey: store.APIKey{ModelAliases: []store.APIKeyModelAlias{{Alias: "friendly", Model: "native"}}}}
	w := httptest.NewRecorder()
	app.serveModelCatalog(w, httptest.NewRequest(http.MethodGet, "/v1/models", nil), key)
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	var document struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Data) != 2 {
		t.Fatalf("catalog leaked a denied model: %s", w.Body.String())
	}
	for _, item := range document.Data {
		if item["context_length"] != float64(1000000) || item["native_endpoints"].([]any)[0] != "/responses" {
			t.Fatalf("ordinary list lacks Responses facts: %s", w.Body.String())
		}
	}
}
