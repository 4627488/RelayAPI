package app

import (
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestEffectiveSubscriptionModels(t *testing.T) {
	parent := store.ParentSubscription{
		CPAModelAllowlist: []string{"gpt-5.2", "gpt-5.1-codex", "claude-sonnet"},
		ModelAllowlist:    []string{"gpt-*"},
	}
	child := store.ChildSubscription{ModelAllowlist: []string{"gpt-5.1-*"}}
	models, source := effectiveSubscriptionModels(parent, child)
	if source != "child" || len(models) != 1 || models[0] != "gpt-5.1-codex" {
		t.Fatalf("effective models = %v (%s)", models, source)
	}

	models, source = effectiveSubscriptionModels(store.ParentSubscription{
		CPAModelAllowlist: []string{"model-b", "model-a", "model-a"},
	}, store.ChildSubscription{})
	if source != "cpa" || len(models) != 2 || models[0] != "model-a" || models[1] != "model-b" {
		t.Fatalf("inherited models = %v (%s)", models, source)
	}

	models, source = effectiveSubscriptionModels(
		store.ParentSubscription{ModelAllowlist: []string{"gpt-*"}},
		store.ChildSubscription{ModelAllowlist: []string{"gpt-5.2", "claude-sonnet"}},
	)
	if source != "child" || len(models) != 1 || models[0] != "gpt-5.2" {
		t.Fatalf("concrete child models = %v (%s)", models, source)
	}

	models, _ = effectiveSubscriptionModels(
		store.ParentSubscription{ModelAllowlist: []string{"gpt-*"}},
		store.ChildSubscription{},
	)
	if len(models) != 0 {
		t.Fatalf("wildcard policy must not be presented as concrete models: %v", models)
	}
}

func TestProjectTenantEntitlements(t *testing.T) {
	reset := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	used := 40.0
	items := projectTenantEntitlements(
		[]store.ParentQuotaWindow{{Kind: "5h", LimitNanoUSD: 10_000_000_000, ResetsAt: reset, Source: "observed", ObservedUsedPercent: &used}},
		store.ChildSubscription{AllocationPPM: 50_000},
		[]store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 500_000_000, SettledNanoUSD: 100_000_000, ReservedNanoUSD: 20_000_000, ResetsAt: reset}},
	)
	if len(items) != 1 {
		t.Fatalf("entitlements = %+v", items)
	}
	if items[0].ParentLimitNanoUSD != 10_000_000_000 || items[0].LimitNanoUSD != 500_000_000 ||
		items[0].RemainingNanoUSD != 380_000_000 || items[0].UpstreamUsedPercent == nil || *items[0].UpstreamUsedPercent != 40 {
		t.Fatalf("entitlement = %+v", items[0])
	}
}
