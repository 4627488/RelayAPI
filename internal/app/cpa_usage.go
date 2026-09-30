package app

import (
	"context"
	"strings"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/store"
	relaybridge "github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

// CPA owns text token interpretation. Keep modality accounting until its public
// usage SDK exposes image buckets; aggregate totals cannot price images safely.
func (a *App) cpaBillingUsage(ctx context.Context, requestID, responseID, endpoint string, observed billing.Result) billing.Result {
	if a.nativeCPARuntime == nil {
		return observed
	}
	if strings.Contains(endpoint, "/images") || observed.Usage.ImageInput > 0 || observed.Usage.ImageOutput > 0 {
		return observed
	}
	result, complete := a.nativeCPARuntime.RequestUsage(ctx, requestID, responseID)
	canonical := cpaUsageResult(result, complete)
	if canonical.RequestID == "" {
		canonical.RequestID = observed.RequestID
	}
	if canonical.Model == "" {
		canonical.Model = observed.Model
	}
	return canonical
}

func cpaUsageResult(result relaybridge.UsageResult, complete bool) billing.Result {
	return billing.Result{
		RequestID: result.ResponseID, Model: result.Model,
		ResponseServiceTier: result.ServiceTier, Found: complete && result.Found,
		Usage: store.Usage{
			// Relay's prompt bucket includes cache reads but excludes cache writes.
			Prompt: result.InputTokens - result.CacheWriteTokens,
			Cached: result.CachedTokens, CacheWrite: result.CacheWriteTokens,
			Completion: result.OutputTokens, Reasoning: result.ReasoningTokens,
			Total: result.TotalTokens,
		},
	}
}
