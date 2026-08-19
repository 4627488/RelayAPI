package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProbeQuotaUsesCredentialExtensionWithoutNetwork(t *testing.T) {
	reset := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	document, _ := json.Marshal(map[string]any{"type": "codex", "relay_quota": map[string]any{"plan_type": "pro", "windows": []any{map[string]any{"kind": "5h", "used_percent": 25, "resets_at": reset.Format(time.RFC3339), "enforceable": true}}}})
	report, err := ProbeQuota(t.Context(), QuotaProbeCredential{AuthIndex: "codex-1", Provider: "codex", Document: document})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Source != "credential-extension" || report.PlanType != "pro" || len(report.Windows) != 1 {
		t.Fatalf("report = %#v", report)
	}
	window := report.Windows[0]
	if window.UsedPercent == nil || *window.UsedPercent != 25 || window.RemainingPercent == nil || *window.RemainingPercent != 75 || window.ResetsAt == nil || !window.ResetsAt.Equal(reset) {
		t.Fatalf("window = %#v", window)
	}
}

func TestProbeKimiQuotaFallsBackAndNormalizesAmount(t *testing.T) {
	now := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != kimiQuotaUserAgent || r.Header.Get("X-Msh-Platform") != kimiQuotaPlatform {
			t.Errorf("fingerprint headers = %q %q", r.Header.Get("User-Agent"), r.Header.Get("X-Msh-Platform"))
		}
		if r.URL.Path == "/primary" {
			http.Error(w, "region", http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"plan": "pro", "usage": map[string]any{"used": 25, "limit": 100, "reset_in": 3600}}})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(context.Background(), server.Client(), quotaEndpoints{kimiUsage: server.URL + "/primary", kimiUsageFallback: server.URL + "/fallback"}, "kimi-1", "kimi", map[string]any{"access_token": "token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "kimi-global-usage" || report.PlanType != "pro" || len(report.Windows) != 1 {
		t.Fatalf("report = %#v", report)
	}
	window := report.Windows[0]
	if window.Kind != quotaKind7d || window.UsedPercent == nil || *window.UsedPercent != 25 || window.Remaining == nil || *window.Remaining != 75 {
		t.Fatalf("window = %#v", window)
	}
}

func TestProbeKimiQuotaMapsOfficialFiveHourAndWeeklyWindows(t *testing.T) {
	now := time.Now().UTC()
	reset7d := now.Add(48 * time.Hour).Format(time.RFC3339Nano)
	reset5h := now.Add(2 * time.Hour).Format(time.RFC3339Nano)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Msh-Device-Id") != "device-9" {
			t.Errorf("device id = %q", r.Header.Get("X-Msh-Device-Id"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"usage": map[string]any{"used": "214", "limit": "2048", "remaining": "1834", "resetTime": reset7d},
			"limits": []any{map[string]any{
				"window": map[string]any{"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
				"detail": map[string]any{"used": "139", "limit": "200", "remaining": "61", "resetTime": reset5h},
			}},
			"user": map[string]any{"membership": map[string]any{"level": "LEVEL_INTERMEDIATE"}},
		})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{kimiUsage: server.URL}, "kimi-1", "kimi", map[string]any{"access_token": "token", "device_id": "device-9"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.PlanType != "INTERMEDIATE" || len(report.Windows) != 2 {
		t.Fatalf("report = %#v", report)
	}
	byKind := quotaWindowsByKind(report.Windows)
	if byKind[quotaKind5h].UsedPercent == nil || *byKind[quotaKind5h].UsedPercent != 69.5 || !byKind[quotaKind5h].Enforceable {
		t.Fatalf("5h = %#v", byKind[quotaKind5h])
	}
	if byKind[quotaKind7d].UsedPercent == nil || *byKind[quotaKind7d].UsedPercent != 10.44921875 {
		t.Fatalf("7d = %#v", byKind[quotaKind7d])
	}
}

func TestProbeCodexQuotaRequiresAccountID(t *testing.T) {
	_, err := probeQuotaWithClient(t.Context(), http.DefaultClient, quotaEndpoints{codexUsage: "https://example.invalid"}, "codex-1", "codex", map[string]any{"access_token": "token"}, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "chatgpt account id") {
		t.Fatalf("err = %v", err)
	}
}

func TestProbeCodexQuotaMapsWhamWindowsAndSpark(t *testing.T) {
	now := time.Now().UTC()
	reset5h := now.Add(90 * time.Minute).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("ChatGPT-Account-ID") != "acct_1" {
			t.Errorf("account id = %q", r.Header.Get("ChatGPT-Account-ID"))
		}
		if r.Header.Get("OpenAI-Beta") != "codex-1" || r.Header.Get("Originator") != "Codex Desktop" {
			t.Errorf("codex headers = %q %q", r.Header.Get("OpenAI-Beta"), r.Header.Get("Originator"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"plan_type": "plus",
			"rate_limit": map[string]any{
				"primary_window":   map[string]any{"used_percent": 34, "limit_window_seconds": 18000, "reset_at": reset5h},
				"secondary_window": map[string]any{"used_percent": 37, "limit_window_seconds": 604800, "reset_after_seconds": 520217},
			},
			"additional_rate_limits": []any{map[string]any{
				"limit_name":      "GPT-5.3-Codex-Spark",
				"metered_feature": "codex_bengalfox",
				"rate_limit": map[string]any{
					"primary_window":   map[string]any{"used_percent": 10, "limit_window_seconds": 18000, "reset_after_seconds": 18000},
					"secondary_window": map[string]any{"used_percent": 2, "limit_window_seconds": 604800, "reset_after_seconds": 400000},
				},
			}},
		})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{codexUsage: server.URL}, "codex-1", "codex", map[string]any{"access_token": "token", "account_id": "acct_1"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "codex-wham" || report.PlanType != "plus" {
		t.Fatalf("report = %#v", report)
	}
	byKind := quotaWindowsByKind(report.Windows)
	if byKind[quotaKind5h].UsedPercent == nil || *byKind[quotaKind5h].UsedPercent != 34 || !byKind[quotaKind5h].Enforceable || byKind[quotaKind5h].ResetsAt == nil {
		t.Fatalf("5h = %#v", byKind[quotaKind5h])
	}
	if byKind[quotaKind7d].UsedPercent == nil || *byKind[quotaKind7d].UsedPercent != 37 || byKind[quotaKind7d].ResetsAt == nil {
		t.Fatalf("7d = %#v", byKind[quotaKind7d])
	}
	if byKind[quotaKindSpark5h].Enforceable || byKind[quotaKindSpark5h].UsedPercent == nil || *byKind[quotaKindSpark5h].UsedPercent != 10 {
		t.Fatalf("spark 5h = %#v", byKind[quotaKindSpark5h])
	}
	if byKind[quotaKindSpark7d].Enforceable || byKind[quotaKindSpark7d].UsedPercent == nil || *byKind[quotaKindSpark7d].UsedPercent != 2 {
		t.Fatalf("spark 7d = %#v", byKind[quotaKindSpark7d])
	}
}

func TestProbeXAIQuotaUsesCreditsPercentAndSubscriptionTier(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(24 * time.Hour).Format(time.RFC3339)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" {
			t.Errorf("token auth = %q", r.Header.Get("X-XAI-Token-Auth"))
		}
		if r.URL.RawQuery == "format=credits" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"subscriptionTier": "grok-pro",
				"config": map[string]any{
					"creditUsagePercent": 12.5,
					"currentPeriod":      map[string]any{"end": reset, "type": "USAGE_PERIOD_TYPE_WEEKLY"},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"config": map[string]any{"used": 3000, "monthlyLimit": 15000, "billingPeriodEnd": reset},
		})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{xaiCredits: server.URL + "?format=credits", xaiBilling: server.URL}, "xai-1", "xai", map[string]any{"access_token": "token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.PlanType != "grok-pro" || report.Source != "xai-billing" {
		t.Fatalf("report = %#v", report)
	}
	byKind := quotaWindowsByKind(report.Windows)
	if byKind[quotaKind7d].UsedPercent == nil || *byKind[quotaKind7d].UsedPercent != 12.5 || !byKind[quotaKind7d].Enforceable {
		t.Fatalf("7d = %#v", byKind[quotaKind7d])
	}
	if byKind[quotaKindMonthly].Enforceable || byKind[quotaKindMonthly].UsedPercent == nil || *byKind[quotaKindMonthly].UsedPercent != 20 {
		t.Fatalf("monthly = %#v", byKind[quotaKindMonthly])
	}
}

func TestProbeXAIQuotaTreatsPersonalTeam412AsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPreconditionFailed)
		_, _ = w.Write([]byte(`{"error":"No personal team."}`))
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{xaiCredits: server.URL + "?format=credits", xaiBilling: server.URL}, "xai-1", "xai", map[string]any{"access_token": "token"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if report.Supported || len(report.Windows) != 0 {
		t.Fatalf("report = %#v", report)
	}
}

func TestUnsupportedProviderQuotaIsExplicit(t *testing.T) {
	report, err := probeQuotaWithClient(t.Context(), http.DefaultClient, quotaEndpoints{}, "unknown-1", "unknown", map[string]any{}, time.Now().UTC())
	if err != nil || report.Supported || report.Windows == nil {
		t.Fatalf("report = %#v, err = %v", report, err)
	}
}

func quotaWindowsByKind(windows []QuotaWindow) map[string]QuotaWindow {
	result := make(map[string]QuotaWindow, len(windows))
	for _, window := range windows {
		result[window.Kind] = window
	}
	return result
}
