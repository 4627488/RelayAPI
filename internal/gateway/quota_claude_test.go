package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClaudeQuotaSubscriptionWindows(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(time.Hour).Format(time.RFC3339Nano)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer subscription-token" || r.Header.Get("Anthropic-Beta") != "oauth-2025-04-20" {
			t.Errorf("unexpected quota request: %s %v", r.Method, r.Header)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"five_hour":                  map[string]any{"utilization": 0.5, "resets_at": reset},
			"seven_day":                  map[string]any{"utilization": 0, "resets_at": reset},
			"seven_day_sonnet":           map[string]any{"utilization": 80, "resets_at": reset},
			"seven_day_opus":             nil,
			"seven_day_oauth_apps":       map[string]any{"utilization": 10},
			"seven_day_overage_included": map[string]any{"utilization": 35, "resets_at": reset},
			"extra_usage":                map[string]any{"is_enabled": true, "utilization": 12.5},
		})
	}))
	defer server.Close()
	for _, provider := range []string{"claude", "anthropic"} {
		report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{claudeUsage: server.URL}, "claude-1", provider, map[string]any{"access_token": "subscription-token"}, now)
		if err != nil {
			t.Fatal(err)
		}
		if !report.Supported || report.Source != "claude-oauth-usage" || len(report.Windows) != 6 {
			t.Fatalf("report = %+v", report)
		}
		windows := quotaWindowsByKind(report.Windows)
		if *windows[quotaKind5h].UsedPercent != 0.5 || *windows[quotaKind5h].RemainingPercent != 99.5 || !windows[quotaKind5h].Enforceable {
			t.Fatalf("5h = %+v", windows[quotaKind5h])
		}
		if *windows[quotaKind7d].UsedPercent != 0 || !windows[quotaKind7d].Enforceable {
			t.Fatalf("7d = %+v", windows[quotaKind7d])
		}
		for _, kind := range []string{"7d-sonnet", "7d-oauth-apps", "7d-overage-included", "extra-usage"} {
			if windows[kind].Enforceable {
				t.Fatalf("scoped window must not block all models: %+v", windows[kind])
			}
		}
	}
}

func TestClaudeQuotaFailuresAreNotUnsupportedOrFree(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"unauthorized", 401, `{"error":"expired"}`, "HTTP 401"},
		{"throttled", 429, `{"error":"rate limit"}`, "HTTP 429"},
		{"empty", 200, `{"five_hour":null,"seven_day":null}`, "no usable windows"},
		{"missing utilization", 200, `{"five_hour":{"resets_at":"2030-01-01T00:00:00Z"}}`, "no usable windows"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			_, err := probeClaudeQuota(t.Context(), server.Client(), server.URL, "claude-1", "claude", map[string]any{"access_token": "token"}, time.Now())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestClaudeQuotaAPIKeyDoesNotCallSubscriptionEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("API key must not query subscription usage") }))
	defer server.Close()
	report, err := probeClaudeQuota(t.Context(), server.Client(), server.URL, "claude-key", "claude", map[string]any{"api_key": "key"}, time.Now())
	if err != nil || report.Supported || len(report.Windows) != 0 {
		t.Fatalf("report = %+v; err = %v", report, err)
	}
	_, err = probeClaudeQuota(t.Context(), server.Client(), server.URL, "claude-broken", "claude", map[string]any{}, time.Now())
	if err == nil {
		t.Fatal("missing OAuth token must be an error")
	}
}

func TestClaudeQuotaExpiredResetCannotConstrainAdmission(t *testing.T) {
	now := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"five_hour": map[string]any{"utilization": 100, "resets_at": now.Add(-time.Hour).Format(time.RFC3339)}})
	}))
	defer server.Close()
	report, err := probeClaudeQuota(t.Context(), server.Client(), server.URL, "claude-1", "claude", map[string]any{"access_token": "token"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.Windows[0].Enforceable || report.Windows[0].ResetsAt != nil {
		t.Fatalf("stale window = %+v", report.Windows[0])
	}
}
