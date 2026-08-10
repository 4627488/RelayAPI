package app

import (
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestCapacityModesExcludeLegacyManualWindows(t *testing.T) {
	if !validCapacityMode("unmetered") || !validCapacityMode("observed") {
		t.Fatal("current capacity modes must remain valid")
	}
	if validCapacityMode("manual") {
		t.Fatal("legacy manual-window mode must be rejected")
	}
}

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

func TestTenantSubscriptionAvailability(t *testing.T) {
	now := time.Now()
	activeParent := store.ParentSubscription{Enabled: true}
	activeChild := store.ChildSubscription{Enabled: true, StartsAt: now.Add(-time.Minute)}

	if available, message := tenantSubscriptionAvailability(activeParent, activeChild, now); !available || message != "" {
		t.Fatalf("active subscription = %v, %q", available, message)
	}
	for name, testCase := range map[string]struct {
		parent store.ParentSubscription
		child  store.ChildSubscription
	}{
		"child disabled":     {parent: activeParent, child: store.ChildSubscription{StartsAt: activeChild.StartsAt}},
		"not started":        {parent: activeParent, child: store.ChildSubscription{Enabled: true, StartsAt: now.Add(time.Minute)}},
		"expired":            {parent: activeParent, child: store.ChildSubscription{Enabled: true, StartsAt: activeChild.StartsAt, ExpiresAt: timePointer(now.Add(-time.Second))}},
		"parent disabled":    {parent: store.ParentSubscription{}, child: activeChild},
		"parent unavailable": {parent: store.ParentSubscription{Enabled: true, CPAUnavailable: true}, child: activeChild},
	} {
		t.Run(name, func(t *testing.T) {
			if available, message := tenantSubscriptionAvailability(testCase.parent, testCase.child, now); available || message == "" {
				t.Fatalf("unavailable subscription = %v, %q", available, message)
			}
		})
	}
}

func timePointer(value time.Time) *time.Time { return &value }
