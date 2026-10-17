package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestTenantSubscriptionProjectionHidesCredentialIdentity(t *testing.T) {
	parent := store.ParentSubscription{ID: "private-parent", Name: "upstream@example.test", UpstreamCredentialID: "private-credential", UpstreamCredentialName: "private-auth-file", PlanType: "private-plan", Enabled: true}
	child := store.ChildSubscription{ID: "child", Name: "研发月度订阅", Enabled: true}
	view := projectTenantSubscription(parent, child, nil, nil, nil, time.Now())
	if view["name"] != child.Name {
		t.Fatalf("editable name lost: %v", view)
	}
	payload, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{parent.ID, parent.Name, parent.UpstreamCredentialID, parent.UpstreamCredentialName, parent.PlanType, "parent_name", "parent_plan_type"} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("tenant response exposes %q: %s", secret, payload)
		}
	}
	for _, legacyName := range []string{parent.Name, parent.UpstreamCredentialName, parent.UpstreamCredentialID, "legacy@private.test", ""} {
		child.Name = legacyName
		if got := tenantSubscriptionName(parent, child); got != "模型订阅" {
			t.Fatalf("unsafe legacy name %q became %q", legacyName, got)
		}
	}
}

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
		UpstreamModelAllowlist: []string{"gpt-5.2", "gpt-5.1-codex", "claude-sonnet"},
		ModelAllowlist:         []string{"gpt-*"},
	}
	child := store.ChildSubscription{ModelAllowlist: []string{"gpt-5.1-*"}}
	models, source := effectiveSubscriptionModels(parent, child)
	if source != "child" || len(models) != 1 || models[0] != "gpt-5.1-codex" {
		t.Fatalf("effective models = %v (%s)", models, source)
	}

	models, source = effectiveSubscriptionModels(store.ParentSubscription{
		UpstreamModelAllowlist: []string{"model-b", "model-a", "model-a"},
	}, store.ChildSubscription{})
	if source != "upstream" || len(models) != 2 || models[0] != "model-a" || models[1] != "model-b" {
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

	models, source = effectiveSubscriptionModels(
		store.ParentSubscription{
			CapacityMode:           db.ParentCapacityUnmetered,
			UpstreamModelAllowlist: []string{"grok-4.6", "grok-4.5"},
		},
		store.ChildSubscription{ModelAllowlist: []string{"grok-4.5"}},
	)
	if source != "upstream" || len(models) != 2 {
		t.Fatalf("balance access grant retained legacy child restriction: %v (%s)", models, source)
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
		"parent unavailable": {parent: store.ParentSubscription{Enabled: true, UpstreamUnavailable: true}, child: activeChild},
	} {
		t.Run(name, func(t *testing.T) {
			if available, message := tenantSubscriptionAvailability(testCase.parent, testCase.child, now); available || message == "" {
				t.Fatalf("unavailable subscription = %v, %q", available, message)
			}
		})
	}
}

func timePointer(value time.Time) *time.Time { return &value }
