package pricing

import "testing"

func TestMagpieContextTierCacheTTLAndReasoning(t *testing.T) {
	p := Price{Model: "claude-test", InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 30, CachedInputNanoUSDPerToken: 1, CacheWriteNanoUSDPerToken: 12, CacheWrite1hNanoUSDPerToken: 20, PriceMultiplier: 1,
		Tiers: []Tier{{Above: 100, InputNanoUSDPerToken: 20, OutputNanoUSDPerToken: 45, CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 24, CacheWrite1hNanoUSDPerToken: 40}}}
	snapshot, err := Compile([]Price{p}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ input, want int64 }{{20, 1650}, {21, 3000}} {
		u := Usage{Input: tc.input, CacheRead: 30, CacheWrite: 50, CacheWrite1h: 25, Output: 20, Reasoning: 19}
		resolved, ok := snapshot.Resolve(Dimensions{Model: p.Model, PromptTokens: u.Prompt()})
		if !ok {
			t.Fatal("price missing")
		}
		// At exactly 100: 200+30+300+500+600=1630; at 101: 420+60+600+1000+900=2980.
		want := tc.want - 20
		if got := CostNanoUSD(resolved, u); got != want {
			t.Fatalf("prompt=%d cost=%d want=%d", u.Prompt(), got, want)
		}
		u.Reasoning = 0
		if got := CostNanoUSD(resolved, u); got != want {
			t.Fatal("reasoning was billed twice")
		}
	}
	p.PriceMultiplier = 2
	snapshot, _ = Compile([]Price{p}, nil, nil, nil, nil)
	resolved, _ := snapshot.Resolve(Dimensions{Model: p.Model, PromptTokens: 101})
	if got := CostNanoUSD(resolved, Usage{Input: 101, Output: 1}); got != 4130 {
		t.Fatalf("scaled tier=%d", got)
	}
}
