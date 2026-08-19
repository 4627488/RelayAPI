package pricing

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestResolvePrecedenceAliasAndRules(t *testing.T) {
	admin := []Price{{Model: "openai/gpt-test", InputNanoUSDPerToken: 10, Source: SourceAdmin, Version: "admin", PriceMultiplier: 2}}
	catalog := []Price{{Model: "openai/gpt-test", InputNanoUSDPerToken: 1, Source: SourceCatalog, Version: "catalog", PriceMultiplier: 1}}
	rules := []Rule{
		{Model: "openai/gpt-test", Field: "service_tier", Value: "priority", Multiplier: 1.5},
		{Model: "openai/gpt-test", Field: "auth_index", Value: "auth-1", Multiplier: 2},
	}
	snapshot, err := Compile(admin, catalog, nil, map[string]string{"fast": "openai/gpt-test"}, rules)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "fast", ServiceTier: "priority", AuthIndex: "auth-1"})
	if !ok {
		t.Fatal("price not resolved")
	}
	if got.Source != SourceAdmin || got.PricedModel != "openai/gpt-test" || got.InputNanoUSDPerToken != 60 {
		t.Fatalf("unexpected snapshot: %+v", got)
	}
	if math.Abs(got.PriceMultiplier-6) > 1e-9 || math.Abs(got.RuleMultiplier-3) > 1e-9 {
		t.Fatalf("unexpected multipliers: %+v", got)
	}
}

func TestFetchModelsDevLive(t *testing.T) {
	if os.Getenv("TEST_MODELS_DEV_LIVE") == "" {
		t.Skip("TEST_MODELS_DEV_LIVE is not configured")
	}
	result, err := FetchModelsDev(context.Background(), nil, ModelsDevURL)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) < 100 || result.Version == "" {
		t.Fatalf("unexpected live catalog: count=%d version=%q", len(result.Entries), result.Version)
	}
}

func TestResolveProviderCandidateAndBundledFallback(t *testing.T) {
	snapshot, err := Compile(nil, nil, BundledPrices, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "grok-4.5"})
	if !ok || got.Source != SourceBundled || got.PricedModel != "xai/grok-4.5" {
		t.Fatalf("unexpected fallback: %+v, ok=%v", got, ok)
	}
}

func TestResolveGrok46BundledPrice(t *testing.T) {
	snapshot, err := Compile(nil, nil, BundledPrices, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "grok-4.6"})
	if !ok || got.PricedModel != "xai/grok-4.6" || got.InputNanoUSDPerToken != 2000 || got.CachedInputNanoUSDPerToken != 500 || got.OutputNanoUSDPerToken != 6000 {
		t.Fatalf("unexpected Grok 4.6 price: %+v, ok=%v", got, ok)
	}
}

func TestResolveKimiProviderCandidate(t *testing.T) {
	catalog := []Price{
		{Model: "moonshotai/kimi-k2.5", InputNanoUSDPerToken: 600, OutputNanoUSDPerToken: 3000, Source: SourceCatalog, PriceMultiplier: 1},
		{Model: "moonshotai-cn/kimi-k2.5", InputNanoUSDPerToken: 700, OutputNanoUSDPerToken: 3500, Source: SourceCatalog, PriceMultiplier: 1},
	}
	snapshot, err := Compile(nil, catalog, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "kimi-k2.5"})
	if !ok || got.PricedModel != "moonshotai/kimi-k2.5" || got.InputNanoUSDPerToken != 600 {
		t.Fatalf("unexpected Kimi fallback: %+v, ok=%v", got, ok)
	}
	got, ok = snapshot.Resolve(Dimensions{Model: "moonshotai-cn/kimi-k2.5"})
	if !ok || got.PricedModel != "moonshotai-cn/kimi-k2.5" || got.InputNanoUSDPerToken != 700 {
		t.Fatalf("explicit Kimi provider was not preserved: %+v, ok=%v", got, ok)
	}
}

func TestResolvePrefersModalityAwareBundledImagePrice(t *testing.T) {
	catalog := []Price{{
		Model: "openai/gpt-image-2", InputNanoUSDPerToken: 5000,
		OutputNanoUSDPerToken: 30000, Source: SourceCatalog, PriceMultiplier: 1,
	}}
	bundled := []Price{{
		Model: "gpt-image-2", InputNanoUSDPerToken: 5000,
		ImageInputNanoUSDPerToken: 8000, ImageOutputNanoUSDPerToken: 30000,
		Source: SourceBundled, PriceMultiplier: 1,
	}}
	snapshot, err := Compile(nil, catalog, bundled, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "gpt-image-2"})
	if !ok || got.Source != SourceBundled || got.ImageOutputNanoUSDPerToken != 30000 {
		t.Fatalf("unexpected image fallback: %+v, ok=%v", got, ok)
	}
}

func TestResolveReplacesLegacyAdminImagePriceButPreservesFreeOverride(t *testing.T) {
	bundled := []Price{{Model: "gpt-image-2", ImageOutputNanoUSDPerToken: 30000, Source: SourceBundled, PriceMultiplier: 1}}
	legacy := []Price{{Model: "gpt-image-2", OutputNanoUSDPerToken: 10000, Source: SourceAdmin, PriceMultiplier: 1}}
	snapshot, err := Compile(legacy, nil, bundled, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snapshot.Resolve(Dimensions{Model: "gpt-image-2"})
	if !ok || got.Source != SourceBundled {
		t.Fatalf("legacy image price did not fall back: %+v, ok=%v", got, ok)
	}

	free := []Price{{Model: "gpt-image-2", Source: SourceAdmin, PriceMultiplier: 1}}
	snapshot, err = Compile(free, nil, bundled, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok = snapshot.Resolve(Dimensions{Model: "gpt-image-2"})
	if !ok || got.Source != SourceAdmin || got.ImageOutputNanoUSDPerToken != 0 {
		t.Fatalf("free image override was not preserved: %+v, ok=%v", got, ok)
	}
}

func TestRejectInvalidRule(t *testing.T) {
	if _, err := Compile(nil, nil, nil, nil, []Rule{{Model: "x", Field: "arbitrary", Value: "x", Multiplier: 1}}); err == nil {
		t.Fatal("expected invalid rule error")
	}
}

func TestFetchModelsDevBuildsVersionedFivePartCatalog(t *testing.T) {
	payload := `{
		"openai":{"id":"openai","models":{
			"gpt-test":{"id":"gpt-test","cost":{"input":2.5,"output":10,"cache_read":0.25,"cache_write":3.125}}
		}},
		"moonshotai":{"id":"moonshotai","models":{
			"kimi-k3":{"id":"kimi-k3","name":"Kimi K3","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}],"limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image"]}}
		}},
		"anthropic":{"id":"anthropic","models":{
			"claude-a":{"id":"claude-a","cost":{"input":3,"output":15}},
			"claude-b":{"id":"claude-b","cost":{"input":3,"output":15}},
			"claude-c":{"id":"claude-c","cost":{"input":3,"output":15}},
			"claude-d":{"id":"claude-d","cost":{"input":3,"output":15}},
			"claude-e":{"id":"claude-e","cost":{"input":3,"output":15}},
			"claude-f":{"id":"claude-f","cost":{"input":3,"output":15}},
			"claude-g":{"id":"claude-g","cost":{"input":3,"output":15}},
			"claude-h":{"id":"claude-h","cost":{"input":3,"output":15}},
			"claude-i":{"id":"claude-i","cost":{"input":3,"output":15}}
		}}
	}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()
	result, err := FetchModelsDev(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 10 || result.Version == "" {
		t.Fatalf("unexpected sync result: count=%d version=%q", len(result.Entries), result.Version)
	}
	var found *CatalogEntry
	for index := range result.Entries {
		if result.Entries[index].Model == "openai/gpt-test" {
			found = &result.Entries[index]
		}
	}
	if found == nil || found.InputNanoUSDPerToken != 2500 || found.CachedInputNanoUSDPerToken != 250 ||
		found.CacheWriteNanoUSDPerToken != 3125 || found.ReasoningNanoUSDPerToken != 10000 {
		t.Fatalf("unexpected converted price: %+v", found)
	}
	index := NewCapabilityIndex(result.Version, result.Capabilities)
	kimi, ok := index.Lookup("kimi-k3")
	if !ok || kimi.Context != 1048576 || kimi.Provider != "moonshotai" || !kimi.Reasoning {
		t.Fatalf("unpriced first-party capability missing: %#v ok=%v", kimi, ok)
	}
}
