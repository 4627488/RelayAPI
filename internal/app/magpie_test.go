package app

import (
	"encoding/json"
	"math"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestMagpieBalanceProjectsReservedQuotaAndStablePaths(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	reset := now.Add(time.Hour)
	quotas := []store.SubscriptionQuota{
		{ChildID: "child-1", Name: "套餐;注入: $", Models: []string{"model-a"}, Windows: []store.ChildQuotaWindow{
			{Kind: "5h", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, ResetsAt: reset},
			{Kind: "7d", LimitNanoUSD: 0, ResetsAt: reset},
			{Kind: "unknown", LimitNanoUSD: -1, ResetsAt: reset},
			{Kind: "stale", LimitNanoUSD: 100, ResetsAt: now.Add(-time.Second)},
		}},
		{ChildID: "child-2", Name: "另一个套餐", Models: []string{"model-b"}, Windows: []store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 100, ResetsAt: reset}}},
	}
	doc := projectMagpieBalance(store.KeyContext{TenantBalance: 1234567890}, quotas, now)
	if math.Abs(doc.BalanceUSD-1.23456789) > 1e-10 {
		t.Fatalf("USD conversion: %v", doc.BalanceUSD)
	}
	windows := doc.Subscriptions["qchild_1"]
	if windows["q5h"].Remaining == nil || *windows["q5h"].Remaining != .75 || !windows["q5h"].ResetsAt.Equal(reset) || windows["q5h"].ReservedUSD != 5e-9 || windows["q7d"].State != "exhausted" || windows["qunknown"].Remaining != nil || windows["qstale"].Remaining != nil {
		t.Fatalf("incorrect remaining quota: %+v", windows)
	}
	for _, text := range []string{"model-a", "model-b", "75.0%", "100.0%", "重置", "UTC", "含处理中预留", "额度未知", "等待刷新"} {
		if !strings.Contains(doc.SubscriptionSummary, text) {
			t.Errorf("summary missing %q: %s", text, doc.SubscriptionSummary)
		}
	}
	quotas[0], quotas[1] = quotas[1], quotas[0]
	reordered := projectMagpieBalance(store.KeyContext{}, quotas, now)
	if *reordered.Subscriptions["qchild_1"]["q5h"].Remaining != .75 {
		t.Fatal("reordering changed quota identity")
	}
}

func TestMagpieBalanceDistinguishesCashUnavailableAndUnknown(t *testing.T) {
	now := time.Now()
	doc := projectMagpieBalance(store.KeyContext{}, []store.SubscriptionQuota{
		{ChildID: "cash", BalanceBilled: true},
		{ChildID: "down", Unavailable: true, Windows: []store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 100, ResetsAt: now.Add(time.Hour)}}},
		{ChildID: "unknown"},
	}, now)
	for i, state := range []string{"balance_billed", "unavailable", "unknown"} {
		if doc.Grants[i].State != state {
			t.Fatalf("grant %d: %+v", i, doc.Grants[i])
		}
	}
	if doc.Subscriptions["qdown"]["q5h"].Remaining != nil {
		t.Fatal("outage displayed as usable quota")
	}
	empty := projectMagpieBalance(store.KeyContext{}, nil, now)
	if empty.SubscriptionSummary == "" {
		t.Fatal("missing readable no-plan state")
	}
}

func TestMagpieImportHasBoundedLiveBalancePathAndStableIdentity(t *testing.T) {
	key := store.APIKey{ID: "key-1", Name: strings.Repeat("中文密钥", 30)}
	plain := "secret+&=#中文"
	raw := magpieImportURL("https://relay.example/", plain, key)
	link, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if link.RawQuery != "" || link.Scheme != "https" || link.Host != "usemagpie.ai" || link.Path != "/import" {
		t.Fatalf("unsafe import URL: %s", link)
	}
	params, err := url.ParseQuery(link.EscapedFragment())
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"key": plain, "responses": "https://relay.example/v1",
		"balance": "https://relay.example/v1/usage", "balance_path": magpieBalancePath,
		"keys": "https://relay.example/app/keys", "id": "relayapi-relay.example-key-1",
	} {
		if params.Get(name) != want {
			t.Errorf("%s = %q; want %q", name, params.Get(name), want)
		}
	}
	if len(params.Get("balance_path")) > 200 || len(params.Get("name")) > 80 || !utf8.ValidString(params.Get("name")) {
		t.Fatal("Magpie import parser limits exceeded")
	}
	if params.Has("models") || params.Has("catalog") || params.Has("chat") {
		t.Fatal("discovery must use live authorized Responses catalog")
	}
	key.Name = "renamed"
	renamed, _ := url.Parse(magpieImportURL("https://relay.example", plain, key))
	updated, _ := url.ParseQuery(renamed.EscapedFragment())
	if updated.Get("id") != params.Get("id") {
		t.Fatal("renaming key changed provider identity")
	}
	local, _ := url.Parse(magpieImportURL("http://localhost:3000", plain, key))
	localParams, _ := url.ParseQuery(local.EscapedFragment())
	if localParams.Has("balance") || localParams.Has("balance_path") || localParams.Has("website") {
		t.Fatal("Magpie rejects HTTP balance/website URLs")
	}
	// The same imported path reads newly assigned grants, without embedding any IDs.
	many := make([]store.SubscriptionQuota, 100)
	for i := range many {
		many[i] = store.SubscriptionQuota{ChildID: strings.Repeat("long", 30) + string(rune('a'+i)), Name: strings.Repeat("套餐", 100)}
	}
	doc := projectMagpieBalance(store.KeyContext{}, many, time.Now())
	if len(doc.Grants) != 100 || len(magpieBalancePath) > 200 {
		t.Fatal("grant growth broke stable projection")
	}
	payload, err := json.Marshal(doc)
	if err != nil || !strings.Contains(string(payload), `"subscription_summary"`) {
		t.Fatal("live balance document invalid")
	}
}

func TestMagpieBalanceDoesNotPromiseResetAfterSubscriptionExpiry(t *testing.T) {
	now := time.Now()
	expires := now.Add(time.Hour)
	doc := projectMagpieBalance(store.KeyContext{}, []store.SubscriptionQuota{{ChildID: "expires", Name: "短期订阅", ExpiresAt: &expires, Windows: []store.ChildQuotaWindow{{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 100, ResetsAt: now.Add(24 * time.Hour)}}}}, now)
	if !strings.Contains(doc.SubscriptionSummary, "订阅到期前不重置") || !strings.Contains(doc.SubscriptionSummary, "有效至") || doc.Grants[0].ExpiresAt == nil {
		t.Fatalf("reset after expiry advertised as renewal: %s", doc.SubscriptionSummary)
	}
}

func TestMagpiePerformanceCommandMatchesImportedSlugWithoutSecrets(t *testing.T) {
	key := store.APIKey{ID: "KEY_123", Name: "private-name"}
	if got := magpieConfigureCommand("https://Relay.Example:8443", key, true); got != "magpie provider set relayapi-relay-example-8443-key-123 compaction=native socket=auto" {
		t.Fatalf("command: %q", got)
	}
	if got := magpieConfigureCommand("http://localhost:3000", key, false); !strings.HasSuffix(got, "socket=off") {
		t.Fatal(got)
	}
}
