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
	want := billing.Result{RequestID: "resp-1", Model: "gpt-5", ResponseServiceTier: "priority", Found: true, UsageQuality: "complete",
		Usage: store.Usage{Prompt: 80, Cached: 30, CacheWrite: 20, Completion: 50, Reasoning: 10, Total: 150}}
	if result != want {
		t.Fatalf("canonical billing result = %+v, want %+v", result, want)
	}
}

func TestCPANonGenerationKeepsIdentityAndNeverBecomesMissingUsage(t *testing.T) {
	got := cpaUsageResult(relaybridge.UsageResult{ResponseID: "resp_warm", Model: "model",
		ServiceTier: "priority", Quality: "not_generated", InputTokens: 100}, false)
	if !got.NonGenerated() || got.Found || got.RequestID != "resp_warm" || got.Model != "model" || got.Usage != (store.Usage{}) {
		t.Fatalf("prewarm outcome lost: %+v", got)
	}
	if assessment := billing.Assess(got, nil, 10_000_000); !assessment.Complete || assessment.CostNanoUSD != 0 {
		t.Fatalf("prewarm charged: %+v", assessment)
	}
}

func TestCPASyntheticPrewarmRequiresRuntimeIdentityIntentAndZeroUsage(t *testing.T) {
	for _, tc := range []struct {
		name           string
		prewarm, found bool
		id             string
		usage          store.Usage
		want           bool
	}{
		{"synthetic", true, true, "resp_prewarm_123", store.Usage{}, true},
		{"missing", true, false, "resp_prewarm_123", store.Usage{}, false},
		{"upstream_zero", true, true, "resp_upstream", store.Usage{}, false},
		{"generation", false, true, "resp_prewarm_123", store.Usage{}, false},
		{"nonzero", true, true, "resp_prewarm_123", store.Usage{Total: 1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := &App{}
			got := app.cpaBillingUsage(t.Context(), "session", tc.id, "/v1/responses", requestMeta{Prewarm: tc.prewarm},
				billing.Result{RequestID: tc.id, Found: tc.found, Usage: tc.usage})
			if got.NonGenerated() != tc.want {
				t.Fatalf("classification: %+v", got)
			}
		})
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

func TestCPATokenCountsAreCompleteZeroCostOutcomes(t *testing.T) {
	for _, path := range []string{"/v1/messages/count_tokens", "/v1beta/models/gemini-2.5-flash:countTokens"} {
		got := (&App{}).cpaBillingUsage(t.Context(), "count", "", path, requestMeta{Model: "test"},
			billing.Result{Found: true, Usage: store.Usage{Prompt: 100, Total: 100}})
		assessment := billing.Assess(got, nil, 10_000_000)
		if !got.NonGenerated() || got.Usage != (store.Usage{}) || !assessment.Complete || assessment.CostNanoUSD != 0 {
			t.Fatalf("token estimate was charged: %+v %+v", got, assessment)
		}
	}
	if isTokenCountPath("/v1/messages") || isTokenCountPath("/v1beta/models/test:generateContent") {
		t.Fatal("generation must not be classified as counting")
	}
}
