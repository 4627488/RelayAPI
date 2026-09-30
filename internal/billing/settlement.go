package billing

import "github.com/4627488/RelayAPI/internal/store"

// Assessment is the amount actually accrued, including a conservative estimate
// when usage or prices are unavailable. Complete distinguishes exact accounting.
type Assessment struct {
	CostNanoUSD int64
	Complete    bool
}

func Assess(result Result, price *store.ResolvedPrice, reserved int64) Assessment {
	if result.NonGenerated() || (result.Found && result.Usage == (store.Usage{})) {
		return Assessment{Complete: true}
	}
	if result.Found && price != nil && UsageComplete(*price, result.Usage) {
		return Assessment{CostNanoUSD: Cost(*price, result.Usage), Complete: true}
	}
	return Assessment{CostNanoUSD: reserved}
}
