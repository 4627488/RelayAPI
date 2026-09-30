package app

import (
	"testing"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/store"
	relaybridge "github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

func TestCPAUsageCanonicalCacheAndReasoningAccounting(t *testing.T) {
	result := cpaUsageResult(relaybridge.UsageResult{
		ResponseID: "resp-1", Model: "gpt-5", ServiceTier: "priority", Found: true,
		InputTokens: 100, CachedTokens: 30, CacheWriteTokens: 20,
		OutputTokens: 50, ReasoningTokens: 10, TotalTokens: 150,
	}, true)
	want := billing.Result{RequestID: "resp-1", Model: "gpt-5", ResponseServiceTier: "priority", Found: true,
		Usage: store.Usage{Prompt: 80, Cached: 30, CacheWrite: 20, Completion: 50, Reasoning: 10, Total: 150}}
	if result != want {
		t.Fatalf("canonical billing result = %+v, want %+v", result, want)
	}
}

func TestCPAUsageMissingVersusExplicitZero(t *testing.T) {
	if cpaUsageResult(relaybridge.UsageResult{}, false).Found {
		t.Fatal("missing callback must not be treated as free usage")
	}
	if !cpaUsageResult(relaybridge.UsageResult{Found: true}, true).Found {
		t.Fatal("complete zero-token record should remain valid")
	}
}
