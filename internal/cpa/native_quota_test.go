package cpa

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestProbeQuotaMarksUnknownProviderUnsupported(t *testing.T) {
	report, err := probeQuotaWithClient(context.Background(), http.DefaultClient, quotaEndpoints{}, "unknown.json", "unknown", map[string]any{}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.Supported || report.Windows == nil || len(report.Windows) != 0 {
		t.Fatalf("unexpected report: %#v", report)
	}
}
