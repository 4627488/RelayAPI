package app

import (
	"math"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestMagpieBalanceProjectsReservedQuotaAndStablePaths(t *testing.T) {
	reset := time.Now().UTC()
	quotas := []store.SubscriptionQuota{
		{ChildID: "child-1", Name: "套餐;注入: $", Windows: []store.ChildQuotaWindow{
			{Kind: "5h", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, ResetsAt: reset},
			{Kind: "7d", LimitNanoUSD: 0},
			{Kind: "exhausted", LimitNanoUSD: 10, SettledNanoUSD: 15},
		}},
		{ChildID: "child-2", Name: "另一个套餐", Windows: []store.ChildQuotaWindow{{Kind: "5h", LimitNanoUSD: 100}}},
	}
	doc, paths := projectMagpieBalance(store.KeyContext{TenantBalance: 1234567890}, quotas)
	if math.Abs(doc.BalanceUSD-1.23456789) > 1e-10 {
		t.Fatalf("USD conversion: %v", doc.BalanceUSD)
	}
	windows := doc.Subscriptions["qchild_1"]
	if windows["q5h"].Remaining != .75 || !windows["q5h"].ResetsAt.Equal(reset) || windows["q7d"].Remaining != 0 || windows["qexhausted"].Remaining != 0 {
		t.Fatalf("incorrect remaining quota: %+v", windows)
	}
	if strings.Count(paths, ";") != 4 || !strings.Contains(paths, "subscriptions.qchild_1.q5h.remaining %") {
		t.Fatalf("unsafe or incorrect expressions: %s", paths)
	}
	quotas[0], quotas[1] = quotas[1], quotas[0]
	reordered, _ := projectMagpieBalance(store.KeyContext{}, quotas)
	if reordered.Subscriptions["qchild_1"]["q5h"].Remaining != .75 {
		t.Fatal("reordering changed quota identity")
	}
}

func TestMagpieImportUsesFragmentAndNativeProtocols(t *testing.T) {
	key := "secret+&=#中文"
	raw := magpieImportURL("https://relay.example/", key, "余额: $ balance_usd")
	link, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if link.RawQuery != "" || link.Scheme != "https" || link.Host != "usemagpie.ai" || link.Path != "/import" {
		t.Fatalf("unsafe import URL: %s", link)
	}
	_, fragment, _ := strings.Cut(raw, "#")
	params, err := url.ParseQuery(fragment)
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"key": key, "chat": "https://relay.example/v1", "responses": "https://relay.example/v1",
		"anthropic": "https://relay.example", "gemini": "https://relay.example/v1beta",
		"balance": "https://relay.example/api/magpie/balance", "balance_path": "余额: $ balance_usd",
		"keys": "https://relay.example/app/keys",
	} {
		if params.Get(name) != want {
			t.Errorf("%s = %q; want %q", name, params.Get(name), want)
		}
	}
	if params.Has("models") || params.Has("catalog") {
		t.Fatal("model discovery must respect the key's live catalog")
	}
	_, localFragment, _ := strings.Cut(magpieImportURL("http://localhost:3000", key, "balance_usd"), "#")
	localParams, _ := url.ParseQuery(localFragment)
	if localParams.Has("balance") || localParams.Has("balance_path") || localParams.Has("website") {
		t.Fatal("Magpie rejects HTTP balance/website URLs")
	}
}
