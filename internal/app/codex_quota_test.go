package app

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestCodexQuotaMultipleSubscriptionsAndWindows(t *testing.T) {
	now := time.Unix(1900000000, 0)
	reset := now.Add(time.Hour)
	subscriptions := []store.SubscriptionQuota{
		{ChildID: "c1", Provider: "codex", Name: "Codex personal", Windows: []store.ChildQuotaWindow{
			{Kind: "5h", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, ResetsAt: reset},
			{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 40, ResetsAt: reset},
			{Kind: "14d", LimitNanoUSD: 100, SettledNanoUSD: 50, ResetsAt: reset},
		}},
		{ChildID: "g1", Provider: "xai", Name: "Grok personal", Windows: []store.ChildQuotaWindow{{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 70, ResetsAt: reset}}},
		{ChildID: "c2", Provider: "codex", Name: "Codex personal", Windows: []store.ChildQuotaWindow{{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 80, ResetsAt: reset}}},
	}
	events := projectCodexSubscriptionQuotas(subscriptions, now)
	if len(events) != 5 {
		t.Fatalf("events=%+v", events)
	}
	seen := map[string]bool{}
	headers := http.Header{}
	events.setHeaders(headers)
	for i, q := range events {
		if seen[q.LimitID] {
			t.Fatalf("duplicate id %s", q.LimitID)
		}
		seen[q.LimitID] = true
		wantUsed := []float64{25, 40, 50, 70, 80}[i]
		wantMinutes := []int{300, 10080, 20160, 10080, 10080}[i]
		if q.Limits.Primary.UsedPercent != wantUsed || q.Limits.Primary.WindowMinutes != wantMinutes || q.Limits.Primary.ResetAt != reset.Unix() {
			t.Fatalf("quota=%+v", q)
		}
		prefix := "X-" + strings.ReplaceAll(q.LimitID, "_", "-")
		if headers.Get(prefix+"-Primary-Window-Minutes") != strconv.Itoa(wantMinutes) || headers.Get(prefix+"-Limit-Name") != q.LimitName {
			t.Fatalf("headers=%v", headers)
		}
	}
	subscriptions[0].Name = "Renamed"
	subscriptions[0].Windows = subscriptions[0].Windows[1:]
	changed := projectCodexSubscriptionQuotas(subscriptions, now)
	if changed[0].LimitID != events[1].LimitID {
		t.Fatal("rename/window removal changed IDs")
	}
}

func TestCodexQuotaDurationAndInvalidCounters(t *testing.T) {
	for kind, want := range map[string]int{"5h": 300, "7d": 10080, "2h": 120, "24h": 1440, "14d": 20160, "weekly": 10080, "daily": 1440, "2w": 20160, "90m": 90, "monthly": 0, "credits": 0, "-1h": 0, "0h": 0, "30s": 0, "9999999999999999d": 0} {
		if got := codexWindowMinutes(kind); got != want {
			t.Fatalf("%s: got %d want %d", kind, got, want)
		}
	}
	now := time.Now()
	for _, tc := range []struct {
		limit, settled, reserved int64
		reset                    time.Time
		want                     float64
	}{
		{100, 20, 5, now.Add(time.Hour), 25}, {0, 0, 0, now.Add(time.Hour), 100},
		{math.MaxInt64, math.MaxInt64, math.MaxInt64, now.Add(time.Hour), 100},
		{-1, 0, 0, now.Add(time.Hour), -1}, {100, -1, 0, now.Add(time.Hour), -1},
		{100, 0, -1, now.Add(time.Hour), -1}, {100, 0, 0, now, -1},
	} {
		got := projectCodexSubscriptionQuotas([]store.SubscriptionQuota{{ChildID: "c", Windows: []store.ChildQuotaWindow{{Kind: "7d", LimitNanoUSD: tc.limit, SettledNanoUSD: tc.settled, ReservedNanoUSD: tc.reserved, ResetsAt: tc.reset}}}}, now)
		if tc.want < 0 {
			if len(got) != 0 {
				t.Fatalf("invalid quota=%+v", got)
			}
			continue
		}
		if len(got) != 1 || got[0].Limits.Primary.UsedPercent != tc.want {
			t.Fatalf("quota=%+v", got)
		}
	}
}

func TestCodexQuotaSelectedSubscriptionReplacesBothWindows(t *testing.T) {
	now := time.Now()
	window := func(kind string, used int64) store.ChildQuotaWindow {
		return store.ChildQuotaWindow{Kind: kind, LimitNanoUSD: 100, SettledNanoUSD: used, ResetsAt: now.Add(time.Hour)}
	}
	subscriptions := []store.SubscriptionQuota{
		{ChildID: "codex", Name: "Codex personal", Windows: []store.ChildQuotaWindow{window("14d", 90), window("7d", 40), window("2h", 25)}},
		{ChildID: "grok", Name: "Grok personal", Windows: []store.ChildQuotaWindow{window("7d", 70)}},
	}
	first := projectSelectedCodexQuota(subscriptions, "codex", now)
	if first.LimitID != "codex" || first.Limits.Primary.WindowMinutes != 120 || first.Limits.Primary.UsedPercent != 25 || first.Limits.Secondary.WindowMinutes != 10080 || first.Limits.Secondary.UsedPercent != 40 {
		t.Fatalf("selected=%+v", first)
	}
	next := projectSelectedCodexQuota(subscriptions, "grok", now)
	if next.LimitID != first.LimitID || next.LimitName != "Grok personal" || next.Limits.Primary.UsedPercent != 70 || next.Limits.Secondary != nil {
		t.Fatalf("switched=%+v", next)
	}
	for _, id := range []string{"", "missing"} {
		q := projectSelectedCodexQuota(subscriptions, id, now)
		if q.LimitID != first.LimitID || q.Limits.Primary != nil || q.Limits.Secondary != nil {
			t.Fatalf("unmetered=%+v", q)
		}
	}
	q := projectSelectedCodexQuota(subscriptions, "codex", now.Add(2*time.Hour))
	if q.Limits.Primary != nil || q.Limits.Secondary != nil {
		t.Fatal("expired quota retained")
	}
	h := http.Header{}
	first.setHeaders(h)
	if h.Get("X-Codex-Primary-Window-Minutes") != "120" || h.Get("X-Codex-Secondary-Used-Percent") != "40" || len(h) != 7 {
		t.Fatalf("headers=%v", h)
	}
}

func TestCodexQuotaEventsAreClientSpecific(t *testing.T) {
	for _, test := range []struct {
		ua   string
		want bool
	}{
		{"codex_cli_rs/0.156.1 (Windows)", true}, {"codex_vscode/0.156.1", true},
		{"codex-desktop/0.156.1", true}, {"OpenAI/Python 1.0", false}, {"", false},
	} {
		r, _ := http.NewRequest(http.MethodGet, "http://relay.test/v1/responses", nil)
		r.Header.Set("User-Agent", test.ua)
		if got := wantsCodexQuotaEvents(r); got != test.want {
			t.Fatalf("%q: %v", test.ua, got)
		}
	}
}
