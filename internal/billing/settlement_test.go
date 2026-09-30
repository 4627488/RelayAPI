package billing

import (
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"testing"
)

func TestAssessDistinguishesPrewarmZeroGenerationAndUnknownUsage(t *testing.T) {
	price := &store.ResolvedPrice{Price: pricing.Price{InputNanoUSDPerToken: 2, OutputNanoUSDPerToken: 10, PriceMultiplier: 1}}
	for _, tc := range []struct {
		name   string
		result Result
		price  *store.ResolvedPrice
		want   Assessment
	}{
		{"prewarm", Result{UsageQuality: "not_generated"}, nil, Assessment{Complete: true}},
		{"zero_generation", Result{Found: true}, price, Assessment{Complete: true}},
		{"zero_without_price", Result{Found: true}, nil, Assessment{Complete: true}},
		{"missing", Result{}, price, Assessment{CostNanoUSD: 100}},
		{"missing_price", Result{Found: true, Usage: store.Usage{Prompt: 10, Total: 10}}, nil, Assessment{CostNanoUSD: 100}},
		{"generated", Result{Found: true, Usage: store.Usage{Prompt: 10, Completion: 2, Total: 12}}, price, Assessment{CostNanoUSD: 40, Complete: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Assess(tc.result, tc.price, 100); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}
