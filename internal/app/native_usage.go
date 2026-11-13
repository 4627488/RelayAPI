package app

import (
	"context"
	"strings"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

// Only the terminal Codex response is authoritative for generation usage.
func nativeBillingUsage(meta requestMeta, observed billing.Result) billing.Result {
	if meta.Prewarm && observed.Found && observed.Usage == (store.Usage{}) {
		observed.UsageQuality = "not_generated"
	}
	return observed
}

// A user price for the requested model wins. Otherwise price the model the
// upstream says it served, falling back to the requested model if unknown.
// This is Magpie Pricer's requested/served precedence, not a model-name guess.
func (a *App) resolveUsagePrice(ctx context.Context, dimensions pricing.Dimensions, served string) (store.ResolvedPrice, error) {
	requested, err := a.store.ResolvePrice(ctx, dimensions)
	served = strings.TrimSpace(served)
	if served != "" && !strings.EqualFold(served, dimensions.Model) && (err != nil || requested.Source != pricing.SourceAdmin) {
		actual := dimensions
		actual.Model = served
		actual.ModelAlias = ""
		if price, servedErr := a.store.ResolvePrice(ctx, actual); servedErr == nil {
			return price, nil
		}
	}
	return requested, err
}
