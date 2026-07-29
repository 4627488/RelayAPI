package app

import (
	"encoding/json"
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
	snapshot, err := json.Marshal(map[string]any{
		"supported": true,
		"windows": []map[string]any{
			{
				"kind": "five_hour", "label": "5 小时", "limit": 1000, "remaining": 600,
				"unit": "tokens", "used_percent": 40, "resets_at": reset, "enforceable": true,
			},
			{"kind": "weekly", "label": "每周", "used_percent": 20, "enforceable": false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	items := projectTenantEntitlements(
		store.ParentSubscription{QuotaSnapshot: snapshot},
		store.ChildSubscription{AllocationPPM: 50_000},
	)
	if len(items) != 2 {
		t.Fatalf("entitlements = %+v", items)
	}
	if items[0].AllocatedLimit == nil || *items[0].AllocatedLimit != 50 ||
		items[0].AllocatedRemaining == nil || *items[0].AllocatedRemaining != 30 ||
		items[0].AvailableShareOfParentPercent == nil || *items[0].AvailableShareOfParentPercent != 3 {
		t.Fatalf("absolute entitlement = %+v", items[0])
	}
	if items[1].UpstreamRemainingPercent == nil || *items[1].UpstreamRemainingPercent != 80 ||
		items[1].AvailableShareOfParentPercent == nil || *items[1].AvailableShareOfParentPercent != 4 {
		t.Fatalf("percentage entitlement = %+v", items[1])
	}
}
