package gateway

import (
	"encoding/json"
	"math"
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

func TestProbeCodexQuotaClassifiesSinglePrimaryWeeklyWindow(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(4 * 24 * time.Hour).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"plan_type": "team", "rate_limits": map[string]any{
			"primary_window":   map[string]any{"used_percent": 17, "limit_window_seconds": 604800, "reset_at": reset},
			"secondary_window": nil,
		}})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{codexUsage: server.URL}, "codex-1", "codex", map[string]any{"access_token": "token", "account_id": "acct_1"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.PlanType != "team" || len(report.Windows) != 1 || report.Windows[0].Kind != quotaKind7d || report.Windows[0].ResetsAt == nil || report.Windows[0].ResetsAt.Unix() != reset {
		t.Fatalf("report = %#v", report)
	}
}

func TestProbeCodexQuotaReadsLegacyPercentLeft(t *testing.T) {
	now := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"rate_limit": map[string]any{
			"five_hour": map[string]any{"percent_left": 73.4, "limit_window_seconds": 18000, "reset_time_ms": now.Add(time.Hour).UnixMilli()},
		}})
	}))
	defer server.Close()
	report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{codexUsage: server.URL}, "codex-1", "codex", map[string]any{"access_token": "token", "account_id": "acct_1"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Windows) != 1 || report.Windows[0].Kind != quotaKind5h || report.Windows[0].UsedPercent == nil || math.Abs(*report.Windows[0].UsedPercent-26.6) > 1e-9 || report.Windows[0].ResetsAt == nil {
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
