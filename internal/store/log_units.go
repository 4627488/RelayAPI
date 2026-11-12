package store

const (
	LogUnitStep       = "step"
	LogUnitPrewarm    = "prewarm"
	LogUnitConnection = "connection"
)

// Request statistics include every generation outcome, regardless of payment.
const generationLogSQL = "request_logs.log_unit = 'step'"

func isBillingDetail(l LogInput) bool {
	return (l.LogUnit == "" || l.LogUnit == LogUnitStep) && l.Settled && l.PricingComplete && l.CostNanoUSD != nil && *l.CostNanoUSD > 0
}
