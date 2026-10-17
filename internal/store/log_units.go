package store

const (
	LogUnitStep       = "step"
	LogUnitPrewarm    = "prewarm"
	LogUnitConnection = "connection"
)

// Billing lists and statistics contain confirmed, paid steps only. Historical
// session summaries and estimates remain stored, but cannot become new bills.
const generationLogSQL = "request_logs.log_unit = 'step' AND request_logs.settled = true AND request_logs.pricing_complete = true AND request_logs.cost_nano_usd > 0"

func isBillingDetail(l LogInput) bool {
	return (l.LogUnit == "" || l.LogUnit == LogUnitStep) && l.Settled && l.PricingComplete && l.CostNanoUSD != nil && *l.CostNanoUSD > 0
}
