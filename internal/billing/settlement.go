package billing

import "github.com/4627488/RelayAPI/internal/store"

// Assessment charges only complete usage with a known price. Missing evidence
// is an uncharged outcome; admission holds are never substituted for usage.
type Assessment struct {
	CostNanoUSD int64
	Complete    bool
}

func Assess(result Result, price *store.ResolvedPrice) Assessment {
	if result.NonGenerated() {
		return Assessment{Complete: true}
	}
	if result.UsageQuality != "" && result.UsageQuality != "complete" {
		return Assessment{}
	}
	if result.Found && result.Usage == (store.Usage{}) {
		return Assessment{Complete: true}
	}
	if result.Found && price != nil && UsageComplete(*price, result.Usage) {
		return Assessment{CostNanoUSD: Cost(*price, result.Usage), Complete: true}
	}
	return Assessment{}
}
