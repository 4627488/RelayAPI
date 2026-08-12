package cpa

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProbeCodexQuotaFromNativeCredential(t *testing.T) {
	now := time.Date(2026, 8, 8, 13, 0, 0, 0, time.UTC)
	reset := now.Add(7 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/codex" || r.Header.Get("Authorization") != "Bearer token" || r.Header.Get("Chatgpt-Account-Id") != "account" {
			t.Fatalf("unexpected request: %s, headers=%v", r.URL.Path, r.Header)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{"primary_window": map[string]any{
				"limit_window_seconds": 604800, "used_percent": 2, "reset_at": reset.Unix(),
			}},
		})
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{codexUsage: server.URL + "/codex"}, "credential.json", "codex", map[string]any{"access_token": "token", "account_id": "account"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "codex-wham" || report.PlanType != "pro" || len(report.Windows) != 1 {
		t.Fatalf("unexpected report: %#v", report)
	}
	window := report.Windows[0]
	if window.Kind != "7d" || window.UsedPercent == nil || *window.UsedPercent != 2 || window.ResetsAt == nil || !window.ResetsAt.Equal(reset) || !window.Enforceable {
		t.Fatalf("unexpected window: %#v", window)
	}
}

func TestProbeXAIQuotaFromNativeCredential(t *testing.T) {
	now := time.Date(2026, 8, 8, 13, 0, 0, 0, time.UTC)
	weeklyReset := now.Add(4 * 24 * time.Hour)
	monthlyReset := now.Add(20 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer xai-token" || r.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" {
			t.Fatalf("unexpected headers: %v", r.Header)
		}
		if r.Header.Get("X-Grok-Client-Version") != xaiQuotaClientVersion || r.Header.Get("X-Grok-Client-Mode") != "interactive" {
			t.Fatalf("stale Grok client headers: %v", r.Header)
		}
		switch r.URL.Path {
		case "/credits":
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{
				"creditUsagePercent": 17, "currentPeriod": map[string]any{"end": weeklyReset.Format(time.RFC3339)},
			}})
		case "/billing":
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{
				"used": map[string]any{"val": 15000}, "monthlyLimit": map[string]any{"val": 150000}, "billingPeriodEnd": monthlyReset.Format(time.RFC3339),
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{xaiCredits: server.URL + "/credits", xaiBilling: server.URL + "/billing"}, "xai.json", "xai", map[string]any{"access_token": "xai-token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "xai-billing" || report.PlanType != "supergrok-heavy" || len(report.Windows) != 2 {
		t.Fatalf("unexpected report: %#v", report)
	}
	if report.Windows[0].Kind != "7d" || report.Windows[1].Kind != "monthly" || report.Windows[1].UsedPercent == nil || *report.Windows[1].UsedPercent != 10 {
		t.Fatalf("unexpected windows: %#v", report.Windows)
	}
}

func TestProbeXAIQuotaSupportsSnakeCaseAndScalarBillingValues(t *testing.T) {
	now := time.Date(2026, 8, 12, 3, 0, 0, 0, time.UTC)
	weeklyReset := now.Add(6 * 24 * time.Hour)
	monthlyReset := now.Add(18 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-userid") != "xai-user" {
			t.Fatalf("missing x-userid header: %v", r.Header)
		}
		switch r.URL.Path {
		case "/credits":
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{
				"credit_usage_percent": 23.5,
				"current_period":       map[string]any{"type": "weekly", "end": weeklyReset.Format(time.RFC3339)},
				"product_usage":        []any{map[string]any{"product": "Grok", "usage_percent": 31}},
			}})
		case "/billing":
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{
				"used": 175000, "monthly_limit": "150000", "billing_period_end": monthlyReset.Format(time.RFC3339),
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{xaiCredits: server.URL + "/credits", xaiBilling: server.URL + "/billing"}, "xai.json", "xai", map[string]any{"access_token": "xai-token", "user_id": "xai-user"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.PlanType != "supergrok-heavy" || len(report.Windows) != 3 {
		t.Fatalf("unexpected report: %#v", report)
	}
	weekly := quotaWindowByKind(t, report.Windows, "7d")
	if weekly.UsedPercent == nil || *weekly.UsedPercent != 23.5 || weekly.ResetsAt == nil || !weekly.ResetsAt.Equal(weeklyReset) || !weekly.Enforceable {
		t.Fatalf("unexpected weekly window: %#v", weekly)
	}
	monthly := quotaWindowByKind(t, report.Windows, "monthly")
	if monthly.UsedPercent == nil || *monthly.UsedPercent != 100 || monthly.Enforceable {
		t.Fatalf("monthly billing must be visible but not enforceable: %#v", monthly)
	}
}

func TestProbeXAIQuotaExposesCurrentBalancesAndMonthlyPeriod(t *testing.T) {
	now := time.Date(2026, 8, 13, 3, 0, 0, 0, time.UTC)
	reset := now.Add(18 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/credits":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"subscriptionTier": "SuperGrok Heavy",
				"config": map[string]any{
					"creditUsagePercent": 42.5,
					"currentPeriod":      map[string]any{"type": "USAGE_PERIOD_TYPE_MONTHLY", "end": reset.Format(time.RFC3339)},
					"prepaidBalance":     map[string]any{"val": -2500},
					"onDemandCap":        map[string]any{"val": 5000},
					"onDemandUsed":       map[string]any{"val": 1250},
				},
			})
		case "/billing":
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{xaiCredits: server.URL + "/credits", xaiBilling: server.URL + "/billing"}, "xai.json", "xai", map[string]any{"access_token": "xai-token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.PlanType != "SuperGrok Heavy" || len(report.Windows) != 3 {
		t.Fatalf("unexpected report: %#v", report)
	}
	monthly := quotaWindowByKind(t, report.Windows, "monthly")
	if monthly.UsedPercent == nil || *monthly.UsedPercent != 42.5 || monthly.ResetsAt == nil || !monthly.ResetsAt.Equal(reset) || !monthly.Enforceable {
		t.Fatalf("unexpected monthly window: %#v", monthly)
	}
	prepaid := quotaWindowByKind(t, report.Windows, "prepaid-credits")
	if prepaid.Remaining == nil || *prepaid.Remaining != 25 || prepaid.Unit != "USD" || prepaid.Enforceable {
		t.Fatalf("unexpected prepaid balance: %#v", prepaid)
	}
	onDemand := quotaWindowByKind(t, report.Windows, "on-demand")
	if onDemand.Limit == nil || *onDemand.Limit != 50 || onDemand.Remaining == nil || *onDemand.Remaining != 37.5 || onDemand.UsedPercent == nil || *onDemand.UsedPercent != 25 {
		t.Fatalf("unexpected on-demand balance: %#v", onDemand)
	}
}

func TestProbeXAIQuotaEmptyPayloadReportsOnlyShape(t *testing.T) {
	now := time.Date(2026, 8, 12, 3, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{"new_secret_value": "must-not-leak", "new_field": true}})
	}))
	defer server.Close()

	_, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{xaiCredits: server.URL, xaiBilling: server.URL}, "xai.json", "xai", map[string]any{"access_token": "xai-token"}, now)
	if err == nil || !strings.Contains(err.Error(), "config keys [new_field,new_secret_value]") || strings.Contains(err.Error(), "must-not-leak") {
		t.Fatalf("unexpected diagnostic: %v", err)
	}
}

func TestProbeClaudeQuotaFromNativeCredential(t *testing.T) {
	now := time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)
	fiveHourReset := now.Add(3 * time.Hour)
	weeklyReset := now.Add(5 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/claude" || r.Header.Get("Authorization") != "Bearer claude-token" || r.Header.Get("Anthropic-Beta") != "oauth-2025-04-20" {
			t.Fatalf("unexpected request: %s, headers=%v", r.URL.Path, r.Header)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"rate_limit_tier": "max",
			"five_hour":       map[string]any{"utilization": 31.5, "resets_at": fiveHourReset.Format(time.RFC3339)},
			"seven_day":       map[string]any{"utilization": 42, "resets_at": weeklyReset.Format(time.RFC3339)},
			"seven_day_sonnet": map[string]any{
				"utilization": 12, "resets_at": weeklyReset.Format(time.RFC3339),
			},
			"iguana_necktie": map[string]any{"is_enabled": true, "used_credits": 25, "monthly_limit": 100},
		})
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{claudeUsage: server.URL + "/claude"}, "claude.json", "claude", map[string]any{"access_token": "claude-token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "claude-oauth-usage" || report.PlanType != "max" || len(report.Windows) != 4 {
		t.Fatalf("unexpected report: %#v", report)
	}
	primary := quotaWindowByKind(t, report.Windows, "5h")
	if primary.UsedPercent == nil || *primary.UsedPercent != 31.5 || primary.ResetsAt == nil || !primary.ResetsAt.Equal(fiveHourReset) || !primary.Enforceable {
		t.Fatalf("unexpected primary window: %#v", primary)
	}
	sonnet := quotaWindowByKind(t, report.Windows, "sonnet-7d")
	if sonnet.Enforceable {
		t.Fatalf("model-specific window must not be enforceable: %#v", sonnet)
	}
	extra := quotaWindowByKind(t, report.Windows, "extra-credits")
	if extra.Limit == nil || *extra.Limit != 100 || extra.Remaining == nil || *extra.Remaining != 75 || extra.Unit != "credits" {
		t.Fatalf("unexpected extra credits: %#v", extra)
	}
}

func TestProbeAntigravityQuotaFromNativeCredential(t *testing.T) {
	now := time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)
	reset := now.Add(2 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer google-token" {
			t.Fatalf("unexpected request: %s %s, headers=%v", r.Method, r.URL.Path, r.Header)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case "/load":
			if lookupQuotaPath(body, "metadata.ideType") != "ANTIGRAVITY" {
				t.Fatalf("unexpected load payload: %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"cloudaicompanionProject": "project-1",
				"currentTier":             map[string]any{"id": "pro-tier"},
			})
		case "/models":
			if body["project"] != "project-1" {
				t.Fatalf("unexpected models payload: %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"models": map[string]any{
				"gemini-3.1-pro": map[string]any{"displayName": "Gemini 3.1 Pro", "quotaInfo": map[string]any{"remainingFraction": 0.8, "resetTime": reset.Format(time.RFC3339)}},
				"claude-sonnet":  map[string]any{"quotaInfo": map[string]any{"remainingFraction": 45, "resetTime": reset.Format(time.RFC3339)}},
				"internal-model": map[string]any{"isInternal": true, "quotaInfo": map[string]any{"remainingFraction": 1}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{
		antigravityLoad: server.URL + "/load", antigravityModels: []string{server.URL + "/models"},
	}, "antigravity.json", "antigravity", map[string]any{"access_token": "google-token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "antigravity-models" || report.PlanType != "pro-tier" || len(report.Windows) != 2 {
		t.Fatalf("unexpected report: %#v", report)
	}
	if report.Windows[0].Kind != "model-claude-sonnet" {
		t.Fatalf("most constrained model should be shown first: %#v", report.Windows)
	}
	window := quotaWindowByKind(t, report.Windows, "model-gemini-3-1-pro")
	if window.Label != "Gemini 3.1 Pro" || window.Enforceable || window.RemainingPercent == nil || *window.RemainingPercent != 80 || window.UsedPercent == nil || *window.UsedPercent != 20 {
		t.Fatalf("unexpected model window: %#v", window)
	}
	percentWindow := quotaWindowByKind(t, report.Windows, "model-claude-sonnet")
	if percentWindow.RemainingPercent == nil || *percentWindow.RemainingPercent != 45 {
		t.Fatalf("percentage remainingFraction was not preserved: %#v", percentWindow)
	}
}

func TestProbeKimiQuotaFallsBackAndNormalizesWindows(t *testing.T) {
	now := time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)
	weeklyReset := now.Add(6 * 24 * time.Hour)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer kimi-token" {
			t.Fatalf("unexpected authorization: %v", r.Header)
		}
		switch r.URL.Path {
		case "/china":
			http.Error(w, "wrong region", http.StatusForbidden)
		case "/global":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
				"plan":  "kimi-pro",
				"usage": map[string]any{"used": 250, "limit": 1000, "reset_at": weeklyReset.Format(time.RFC3339)},
				"limits": []any{map[string]any{
					"name": "5 hour", "detail": map[string]any{"remaining": 70, "limit": 100, "reset_in": 3600},
					"window": map[string]any{"duration": 5, "timeUnit": "HOUR"},
				}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{
		kimiUsage: server.URL + "/china", kimiUsageFallback: server.URL + "/global",
	}, "kimi.json", "kimi", map[string]any{"access_token": "kimi-token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "kimi-global-usage" || report.PlanType != "kimi-pro" || len(report.Windows) != 2 {
		t.Fatalf("unexpected report: %#v", report)
	}
	fiveHour := quotaWindowByKind(t, report.Windows, "5h")
	if fiveHour.UsedPercent == nil || *fiveHour.UsedPercent != 30 || fiveHour.Remaining == nil || *fiveHour.Remaining != 70 || fiveHour.ResetsAt == nil || !fiveHour.ResetsAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("unexpected 5h window: %#v", fiveHour)
	}
	weekly := quotaWindowByKind(t, report.Windows, "7d")
	if weekly.UsedPercent == nil || *weekly.UsedPercent != 25 || weekly.Limit == nil || *weekly.Limit != 1000 || weekly.ResetsAt == nil || !weekly.ResetsAt.Equal(weeklyReset) {
		t.Fatalf("unexpected weekly window: %#v", weekly)
	}
}

func TestProbeQuotaMarksUnknownProviderUnsupported(t *testing.T) {
	report, err := probeQuotaWithClient(context.Background(), http.DefaultClient, quotaEndpoints{}, "unknown.json", "unknown", map[string]any{}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.Supported || report.Windows == nil || len(report.Windows) != 0 {
		t.Fatalf("unexpected report: %#v", report)
	}
}

func TestNativeQuotaProxyPrecedence(t *testing.T) {
	tests := []struct {
		name     string
		document map[string]any
		runtime  string
		want     string
	}{
		{name: "credential wins", document: map[string]any{"proxy_url": "socks5://credential:1080", "_relay_proxy_url": "http://imported:8080"}, runtime: "http://runtime:8080", want: "socks5://credential:1080"},
		{name: "runtime wins over import snapshot", document: map[string]any{"_relay_proxy_url": "http://imported:8080"}, runtime: "direct", want: "direct"},
		{name: "import snapshot fallback", document: map[string]any{"_relay_proxy_url": "http://imported:8080"}, want: "http://imported:8080"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeQuotaProxyURL(test.document, test.runtime); got != test.want {
				t.Fatalf("proxy = %q, want %q", got, test.want)
			}
		})
	}
}

func quotaWindowByKind(t *testing.T, windows []QuotaWindow, kind string) QuotaWindow {
	t.Helper()
	for _, window := range windows {
		if window.Kind == kind {
			return window
		}
	}
	t.Fatalf("quota window %q not found in %#v", kind, windows)
	return QuotaWindow{}
}
