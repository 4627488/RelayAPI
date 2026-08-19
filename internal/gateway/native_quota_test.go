package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	if report.Source != "kimi-global-usage" || len(report.Windows) != 1 {
		t.Fatalf("report = %#v", report)
	}
	window := report.Windows[0]
	if window.UsedPercent == nil || *window.UsedPercent != 25 || window.Remaining == nil || *window.Remaining != 75 {
		t.Fatalf("window = %#v", window)
	}
}

func TestUnsupportedProviderQuotaIsExplicit(t *testing.T) {
	report, err := probeQuotaWithClient(t.Context(), http.DefaultClient, quotaEndpoints{}, "unknown-1", "unknown", map[string]any{}, time.Now().UTC())
	if err != nil || report.Supported || report.Windows == nil {
		t.Fatalf("report = %#v, err = %v", report, err)
	}
}
