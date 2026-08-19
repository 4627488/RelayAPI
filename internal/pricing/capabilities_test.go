package pricing

import "testing"

func TestCapabilityIndexPrefersFirstPartyAndLooksUpBareSlug(t *testing.T) {
	index := NewCapabilityIndex("v1", []Capability{
		{ID: "openrouter/kimi-k3", Provider: "openrouter", Context: 1, Reasoning: true},
		{ID: "moonshotai/kimi-k3", Name: "Kimi K3", Provider: "moonshotai", Context: 1048576, Reasoning: true, ReasoningOptions: []ReasoningOption{{Type: "effort", Values: []string{"low", "high", "max"}}}, InputModalities: []string{"text", "image"}},
	})
	got, ok := index.Lookup("kimi-k3")
	if !ok || got.Provider != "moonshotai" || got.Context != 1048576 {
		t.Fatalf("lookup = %#v ok=%v", got, ok)
	}
	if _, ok := index.Lookup("missing"); ok {
		t.Fatal("missing slug should not resolve")
	}
}

func TestCapabilityFromRawJSONReadsLimitAndReasoning(t *testing.T) {
	raw := `{"id":"kimi-k2.5","name":"Kimi K2.5","reasoning":true,"reasoning_options":[{"type":"toggle"}],"limit":{"context":262144,"output":32768},"modalities":{"input":["text","image"]}}`
	got, ok := CapabilityFromRawJSON("moonshotai/kimi-k2.5", raw)
	if !ok || got.Context != 262144 || !got.Reasoning || got.Name != "Kimi K2.5" || len(got.ReasoningOptions) != 1 {
		t.Fatalf("capability = %#v ok=%v", got, ok)
	}
	index := IndexFromCatalogPrices("sha256:persisted", []string{"moonshotai/kimi-k2.5"}, []string{"moonshotai/kimi-k2.5"}, []string{raw})
	lookedUp, ok := index.Lookup("kimi-k2.5")
	if !ok || lookedUp.Context != 262144 || index.Version() != "sha256:persisted" {
		t.Fatalf("persisted catalog overlay = %#v ok=%v version=%q", lookedUp, ok, index.Version())
	}
}
