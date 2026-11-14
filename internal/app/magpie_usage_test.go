package app

import (
	"encoding/json"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestMagpieUsagePreservesIndependentWindowsAndReservations(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	q := store.SubscriptionQuota{ChildID: "share", Name: "Codex", Models: []string{"codex"}, Windows: []store.ChildQuotaWindow{
		{Kind: "7d", LimitNanoUSD: 800e9, SettledNanoUSD: 100e9, ReservedNanoUSD: 20e9, ResetsAt: now.Add(3 * 24 * time.Hour)},
		{Kind: "5h", LimitNanoUSD: 100e9, SettledNanoUSD: 20e9, ReservedNanoUSD: 5e9, ResetsAt: now.Add(time.Hour)},
	}}
	key := store.KeyContext{TenantBalance: 99e9}
	doc := projectMagpieUsage(key, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if doc.QuotaMapping != "native" || doc.Mode != "quota_limited" || len(doc.RateLimits) != 2 || doc.Remaining != nil || doc.Balance != nil || !doc.IsValid {
		t.Fatalf("invalid native plan: %+v", doc)
	}
	if w := doc.RateLimits[0]; w.Window != "5h" || w.Limit != 100 || w.Used != 25 || w.Remaining != 75 || !w.ResetAt.Equal(q.Windows[1].ResetsAt) {
		t.Fatalf("5h mapping: %+v", w)
	}
	if w := doc.RateLimits[1]; w.Window != "7d" || w.Limit != 800 || w.Used != 120 || w.Remaining != 680 {
		t.Fatalf("7d mapping: %+v", w)
	}
	if doc.BalanceUSD != 99 || magpieBilling(key, []store.SubscriptionQuota{q}, []string{"codex"}) != "plan" {
		t.Fatal("cash was combined with quota or billing misclassified")
	}
	q.Windows = append(q.Windows, store.ChildQuotaWindow{Kind: "1d", LimitNanoUSD: 300e9, SettledNanoUSD: 60e9, ReservedNanoUSD: 10e9, ResetsAt: now.Add(12 * time.Hour)})
	doc = projectMagpieUsage(key, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if len(doc.RateLimits) != 3 || doc.RateLimits[1].Window != "1d" || doc.RateLimits[1].Used != 70 || doc.RateLimits[1].Remaining != 230 || !doc.RateLimits[1].ResetAt.Equal(q.Windows[2].ResetsAt) {
		t.Fatalf("independent day mapping: %+v", doc.RateLimits)
	}
	q.Windows[1].SettledNanoUSD = 110e9
	doc = projectMagpieUsage(key, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if doc.RateLimits[0].Used != 115 || doc.RateLimits[0].Remaining != 0 {
		t.Fatal("overspend was lost")
	}
	q.Windows[1].SettledNanoUSD, q.Windows[1].ReservedNanoUSD = math.MaxInt64, math.MaxInt64
	doc = projectMagpieUsage(key, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if doc.RateLimits[0].Used <= 0 || doc.RateLimits[0].Remaining != 0 {
		t.Fatal("reservation addition overflowed")
	}
}

func TestMagpieUsageDoesNotInventWholeKeyQuotas(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	base := store.SubscriptionQuota{ChildID: "share", Name: "Codex", Models: []string{"codex"}, Windows: []store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 100e9, ResetsAt: now.Add(time.Hour)}}}
	for _, tc := range []struct {
		name, reason string
		change       func(*store.SubscriptionQuota)
	}{
		{"unavailable", "unavailable", func(q *store.SubscriptionQuota) { q.Unavailable = true }},
		{"unobserved", "unknown", func(q *store.SubscriptionQuota) { q.Windows = nil }},
		{"unknown", "unknown", func(q *store.SubscriptionQuota) { q.Windows[0].LimitNanoUSD = -1 }},
		{"zero", "zero_limit", func(q *store.SubscriptionQuota) { q.Windows[0].LimitNanoUSD = 0 }},
		{"stale", "awaiting_refresh", func(q *store.SubscriptionQuota) { q.Windows[0].ResetsAt = now }},
		{"missing reset", "awaiting_refresh", func(q *store.SubscriptionQuota) { q.Windows[0].ResetsAt = time.Time{} }},
		{"monthly", "unsupported_window", func(q *store.SubscriptionQuota) { q.Windows[0].Kind = "30d" }},
		{"duplicate", "unsupported_window", func(q *store.SubscriptionQuota) { q.Windows = append(q.Windows, q.Windows[0]) }},
		{"expires", "expires_before_reset", func(q *store.SubscriptionQuota) { e := now.Add(time.Minute); q.ExpiresAt = &e }},
		{"expires at reset", "expires_before_reset", func(q *store.SubscriptionQuota) { e := q.Windows[0].ResetsAt; q.ExpiresAt = &e }},
		{"expired", "unavailable", func(q *store.SubscriptionQuota) { e := now; q.ExpiresAt = &e }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := base
			q.Windows = slices.Clone(base.Windows)
			tc.change(&q)
			doc := projectMagpieUsage(store.KeyContext{}, []store.SubscriptionQuota{q}, []string{"codex"}, now)
			if doc.QuotaMapping != tc.reason || len(doc.RateLimits) != 0 || doc.Remaining != nil || len(doc.Grants) != 1 {
				t.Fatalf("misleading native quota: %+v", doc)
			}
			b, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			var wire map[string]any
			if json.Unmarshal(b, &wire) != nil || wire["rate_limits"] == nil || wire["subscription_summary"] == nil {
				t.Fatalf("missing fallback: %s", b)
			}
		})
	}
	for _, tc := range []struct {
		name            string
		key             store.KeyContext
		quotas          []store.SubscriptionQuota
		models          []string
		reason, billing string
	}{
		{"model scoped", store.KeyContext{}, []store.SubscriptionQuota{base}, []string{"codex", "payg"}, "model_scoped", "auto"},
		{"no models", store.KeyContext{}, []store.SubscriptionQuota{base}, nil, "no_models", "plan"},
		{"multiple", store.KeyContext{}, []store.SubscriptionQuota{base, base}, []string{"codex"}, "multiple_subscriptions", "plan"},
		{"mixed grants", store.KeyContext{}, []store.SubscriptionQuota{base, {BalanceBilled: true, Models: []string{"payg"}}}, []string{"codex", "payg"}, "multiple_subscriptions", "auto"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := projectMagpieUsage(tc.key, tc.quotas, tc.models, now)
			if doc.QuotaMapping != tc.reason || len(doc.RateLimits) != 0 || doc.Remaining != nil || magpieBilling(tc.key, tc.quotas, tc.models) != tc.billing {
				t.Fatalf("unsafe aggregate: %+v", doc)
			}
		})
	}
	// Denied runtime models and client aliases do not widen the actual model scope.
	key := store.KeyContext{APIKey: store.APIKey{ModelAllowlist: []string{"codex"}, ModelAliases: []store.APIKeyModelAlias{{Alias: "my-model", Model: "codex"}}}}
	doc := projectMagpieUsage(key, []store.SubscriptionQuota{base}, []string{"codex", "denied"}, now)
	if doc.QuotaMapping != "native" {
		t.Fatalf("key scope: %+v", doc)
	}
}

func TestMagpieUsageCashUsesAvailableWalletWithoutSyntheticWindows(t *testing.T) {
	for _, quotas := range [][]store.SubscriptionQuota{nil, {{BalanceBilled: true, Models: []string{"codex"}}}} {
		doc := projectMagpieUsage(store.KeyContext{TenantBalance: 1234567890}, quotas, []string{"codex"}, time.Now())
		if doc.Mode != "unrestricted" || doc.QuotaMapping != "cash" || doc.Balance == nil || doc.Remaining == nil || *doc.Remaining != 1.23456789 || len(doc.RateLimits) != 0 {
			t.Fatalf("wallet mismatch: %+v", doc)
		}
	}
}

func TestMagpieNativeUsageSummaryDoesNotRepeatQuotaCard(t *testing.T) {
	now := time.Now().UTC()
	q := store.SubscriptionQuota{ChildID: "share", Name: " ChatGPT  Pro 4X\n", Models: []string{"codex"},
		Windows: []store.ChildQuotaWindow{{Kind: "7d", LimitNanoUSD: 100e9, SettledNanoUSD: 1e9, ResetsAt: now.Add(time.Hour)}}}
	doc := projectMagpieUsage(store.KeyContext{}, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if doc.SubscriptionSummary != "ChatGPT Pro 4X" || len(doc.RateLimits) != 1 || doc.RateLimits[0].Remaining != 99 || len(doc.Grants[0].Models) != 1 {
		t.Fatalf("native card summary or structured quota changed: %+v", doc)
	}
	q.Name = " \n"
	doc = projectMagpieUsage(store.KeyContext{}, []store.SubscriptionQuota{q}, []string{"codex"}, now)
	if doc.SubscriptionSummary != "订阅" {
		t.Fatalf("missing unnamed plan label: %q", doc.SubscriptionSummary)
	}
}
