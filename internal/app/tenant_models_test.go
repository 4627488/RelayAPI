package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestTenantModelSettlementsFollowClaimsAndHideAccounts(t *testing.T) {
	now := time.Now()
	reset := now.Add(time.Hour)
	shared := tenantModelGrant{
		parent:  store.ParentSubscription{ID: "private-parent", Name: "private@example.test", CapacityMode: "observed", Enabled: true, UpstreamModelAllowlist: []string{"shared"}},
		child:   store.ChildSubscription{ID: "share", Name: "团队订阅", Enabled: true, AllocationPPM: 1000000},
		windows: []store.ParentQuotaWindow{{Kind: "5h", LimitNanoUSD: 100, ResetsAt: reset}},
		state:   []store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 100, SettledNanoUSD: 100}},
	}
	balance := tenantModelGrant{parent: store.ParentSubscription{Name: "another@private.test", CapacityMode: "unmetered", Enabled: true, UpstreamModelAllowlist: []string{"balance", "shared"}}, child: store.ChildSubscription{ID: "balance-private", Enabled: true}}
	items := projectTenantModels([]string{"balance", "shared", "direct", "denied", "shared"}, []string{"direct"}, []tenantModelGrant{shared, balance, balance}, now)
	if len(items) != 3 {
		t.Fatalf("models = %+v", items)
	}
	byID := map[string]tenantModelView{}
	for _, item := range items {
		byID[item.ID] = item
	}
	if len(byID["balance"].Settlements) != 1 || byID["balance"].Settlements[0].Mode != "balance" {
		t.Fatalf("balance grants not merged: %+v", byID["balance"])
	}
	if len(byID["shared"].Settlements) != 2 || byID["shared"].Settlements[0].Available || byID["shared"].Settlements[0].SubscriptionName != "团队订阅" {
		t.Fatalf("exhausted subscription or alternatives wrong: %+v", byID["shared"])
	}
	claimed := projectTenantModels([]string{"shared"}, nil, []tenantModelGrant{shared}, now)
	if len(claimed[0].Settlements) != 1 || claimed[0].Settlements[0].Mode != "subscription" {
		t.Fatalf("claimed model advertised balance fallback: %+v", claimed)
	}
	payload, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-parent", "private@example.test", "another@private.test", "balance-private"} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("exposed %q", secret)
		}
	}
}

func TestTenantModelsRespectLifecycleAndWildcardPolicies(t *testing.T) {
	now := time.Now()
	expired := now.Add(-time.Hour)
	grant := tenantModelGrant{parent: store.ParentSubscription{Enabled: true, CapacityMode: "unmetered", ModelAllowlist: []string{"gpt-*"}, UpstreamModelAllowlist: []string{"gpt-a", "claude"}}, child: store.ChildSubscription{Enabled: true, ModelAllowlist: []string{"obsolete"}}}
	models := []string{"gpt-a", "claude"}
	if got := projectTenantModels(models, []string{"none"}, []tenantModelGrant{grant}, now); len(got) != 1 || got[0].ID != "gpt-a" {
		t.Fatalf("policy = %+v", got)
	}
	grant.child.ExpiresAt = &expired
	if got := projectTenantModels(models, []string{"none"}, []tenantModelGrant{grant}, now); len(got) != 0 {
		t.Fatalf("expired grant exposed models: %+v", got)
	}
}
