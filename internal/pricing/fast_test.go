package pricing

import "testing"

func TestFastPricingActualTierAndOverrides(t *testing.T) {
	price := Price{Model: "gpt-test", InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 12, ReasoningNanoUSDPerToken: 20,
		ImageInputNanoUSDPerToken: 30, CachedImageInputNanoUSDPerToken: 6, ImageOutputNanoUSDPerToken: 40,
		PriceMultiplier: 1}
	for _, tc := range []struct {
		name, requested, actual string
		rules                   []Rule
		multiplier              float64
	}{
		{name: "normal", multiplier: 1},
		{name: "requested fast", requested: "priority", multiplier: 2},
		{name: "actual fast", requested: "auto", actual: "priority", multiplier: 2},
		{name: "downgraded", requested: "priority", actual: "default", multiplier: 1},
		{name: "flex", actual: "flex", multiplier: 1},
		{name: "normalized", actual: " PRIORITY ", multiplier: 2},
		{name: "explicit actual rule", actual: "priority", rules: []Rule{{Model: price.Model, Field: "response_service_tier", Value: "priority", Multiplier: 1.5}}, multiplier: 1.5},
		{name: "explicit request rule", requested: "priority", actual: "priority", rules: []Rule{{Model: price.Model, Field: "service_tier", Value: "priority", Multiplier: 2}}, multiplier: 2},
		{name: "unmatched tier rule", actual: "priority", rules: []Rule{{Model: price.Model, Field: "response_service_tier", Value: "flex", Multiplier: 0.5}}, multiplier: 2},
		{name: "other dimensions compose", actual: "priority", rules: []Rule{{Model: price.Model, Field: "auth_index", Value: "account", Multiplier: 3}}, multiplier: 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot, err := Compile([]Price{price}, nil, nil, map[string]string{"alias": price.Model}, tc.rules)
			if err != nil {
				t.Fatal(err)
			}
			got, ok := snapshot.Resolve(Dimensions{Model: "alias", AuthIndex: "account", ServiceTier: tc.requested, ResponseServiceTier: tc.actual})
			if !ok || got.RuleMultiplier != tc.multiplier || got.InputNanoUSDPerToken != int64(10*tc.multiplier) {
				t.Fatalf("resolved %+v, want multiplier %v", got, tc.multiplier)
			}
		})
	}
	snapshot, err := Compile([]Price{price}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	normal, _ := snapshot.Resolve(Dimensions{Model: price.Model})
	fast, _ := snapshot.Resolve(Dimensions{Model: price.Model, ResponseServiceTier: "priority"})
	usage := Usage{Prompt: 100, Cached: 30, CacheWrite: 20, Completion: 50, Reasoning: 10, Total: 170,
		ImageInput: 10, CachedImageInput: 5, ImageOutput: 5}
	if got, want := CostNanoUSD(fast, usage), 2*CostNanoUSD(normal, usage); got != want {
		t.Fatalf("Fast cost %d, want exactly double %d", got, want)
	}
}
