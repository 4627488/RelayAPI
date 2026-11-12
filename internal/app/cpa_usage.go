package app

import (
	"context"
	"strings"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	relaybridge "github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

// CPA owns text token interpretation. Keep modality accounting until its public
// usage SDK exposes image buckets; aggregate totals cannot price images safely.
func (a *App) cpaBillingUsage(ctx context.Context, requestID, responseID, endpoint string, meta requestMeta, observed billing.Result) billing.Result {
	// Token counting still requires subscription admission and credential pinning,
	// but its estimate is never generation usage or a billable token total.
	if isNonGenerationPath(endpoint) {
		return billing.Result{Model: meta.Model, UsageQuality: "not_generated"}
	}
	// CPA's local WS prewarm has no executor and therefore no usage callback.
	// Its dedicated synthetic identity, explicit request intent and complete
	// zero usage must all match; ordinary missing usage never takes this path.
	if meta.Prewarm && strings.HasPrefix(observed.RequestID, "resp_prewarm_") &&
		observed.Found && observed.Usage == (store.Usage{}) {
		observed.UsageQuality = "not_generated"
		return observed
	}
	if a.nativeCPARuntime == nil {
		return observed
	}
	// CPA's direct Realtime transport does not publish executor usage records.
	// Its terminal response.done envelope is the usage authority for each turn.
	if isRealtimeWebSocketPath(endpoint) && observed.Found {
		return observed
	}
	if strings.Contains(endpoint, "/images") || observed.Usage.ImageInput > 0 || observed.Usage.ImageOutput > 0 {
		return observed
	}
	result, complete := a.nativeCPARuntime.RequestUsage(ctx, requestID, responseID)
	canonical := cpaUsageResult(result, complete)
	if canonical.Found {
		canonical.Usage.CacheWrite1h = min(observed.Usage.CacheWrite1h, canonical.Usage.CacheWrite)
		canonical.Usage.CacheUnknown = observed.Usage.CacheUnknown
	}
	if canonical.RequestID == "" {
		canonical.RequestID = observed.RequestID
	}
	if canonical.Model == "" {
		canonical.Model = observed.Model
	}
	if canonical.ResponseServiceTier == "" {
		canonical.ResponseServiceTier = observed.ResponseServiceTier
	}
	return canonical
}

func cpaUsageResult(result relaybridge.UsageResult, complete bool) billing.Result {
	if result.Quality == "not_generated" {
		return billing.Result{RequestID: result.ResponseID, Model: result.Model,
			ResponseServiceTier: result.ServiceTier, UsageQuality: "not_generated"}
	}
	quality := result.Quality
	if quality == "" {
		quality = "missing"
		if complete && result.Found {
			quality = "complete"
		}
	}
	return billing.Result{
		UsageQuality: quality,
		RequestID:    result.ResponseID, Model: result.Model,
		ResponseServiceTier: result.ServiceTier, Found: complete && result.Found,
		Usage: store.Usage{
			// Disjoint Magpie input bucket; CPA includes both cache buckets.
			Input:     max64(0, result.InputTokens-result.CacheWriteTokens-result.CachedTokens),
			CacheRead: result.CachedTokens, CacheWrite: result.CacheWriteTokens,
			Output: result.OutputTokens, Reasoning: result.ReasoningTokens,
			Total: saturatingAdd(max64(0, result.InputTokens-result.CacheWriteTokens-result.CachedTokens), result.OutputTokens),
		},
	}
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
