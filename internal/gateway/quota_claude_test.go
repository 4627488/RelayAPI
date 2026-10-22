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

func TestClaudeAccountProfileAndUsageFailIndependently(t *testing.T) {
	for _, tc := range []struct {
		name                                    string
		usageStatus, profileStatus              int
		profile, plan, subscriptionStatus, code string
	}{
		{"live upgrade", 200, 200, `{"account":{"email":"private@example.com","has_claude_pro":true},"organization":{"uuid":"private-org","name":"private-name","organization_type":"claude_max","rate_limit_tier":"default_claude_max_20x","subscription_status":"active","billing_type":"stripe_subscription","has_extra_usage_enabled":true}}`, "max", "supported", ""},
		{"team beats personal max", 200, 200, `{"account":{"has_claude_max":true},"organization":{"organization_type":"claude_team","subscription_status":"active"}}`, "team", "supported", ""},
		{"enterprise", 200, 200, `{"organization":{"organization_type":"claude_enterprise"}}`, "enterprise", "supported", ""},
		{"free clears stale max", 200, 200, `{"account":{"has_claude_max":false,"has_claude_pro":false}}`, "free", "supported", ""},
		{"unknown clears stale max", 200, 200, `{"organization":{"organization_type":"unknown_product"}}`, "", "supported", ""},
		{"profile forbidden", 200, 403, `{"email":"private@example.com"}`, "max", "error", "forbidden"},
		{"profile throttled", 200, 429, `{}`, "max", "error", "rate_limited"},
		{"profile expired alone", 200, 401, `{}`, "max", "error", "unauthorized"},
		{"empty profile", 200, 200, `{}`, "max", "error", "invalid_response"},
		{"profile works during usage cooldown", 429, 200, `{"organization":{"organization_type":"claude_pro"}}`, "pro", "supported", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer token" || r.Header.Get("Anthropic-Beta") != "oauth-2025-04-20" {
					t.Errorf("unexpected request: %v", r)
				}
				if r.URL.Path == "/profile" {
					w.WriteHeader(tc.profileStatus)
					_, _ = w.Write([]byte(tc.profile))
					return
				}
				w.WriteHeader(tc.usageStatus)
				_, _ = w.Write([]byte(`{"five_hour":{"utilization":0,"resets_at":null}}`))
			}))
			defer server.Close()
			report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{claudeUsage: server.URL + "/usage", claudeProfile: server.URL + "/profile"}, "test", "claude", map[string]any{"access_token": "token", "subscription_type": "max"}, time.Now())
			if (err != nil) != (tc.usageStatus != 200) {
				t.Fatalf("unexpected usage error: %v", err)
			}
			if report.PlanType != tc.plan || report.Subscription == nil || report.Subscription.Status != tc.subscriptionStatus || report.Subscription.ErrorCode != tc.code {
				t.Fatalf("report = %+v", report)
			}
			if calls != 2 {
				t.Fatalf("calls = %d", calls)
			}
			encoded, _ := json.Marshal(report)
			for _, secret := range []string{"private@example.com", "private-org", "private-name", "Bearer", `"access_token"`} {
				if strings.Contains(string(encoded), secret) {
					t.Fatalf("snapshot leaked %q: %s", secret, encoded)
				}
			}
			if tc.name == "live upgrade" && (report.Subscription.RateLimitTier != "default_claude_max_20x" || report.Subscription.ExtraUsageEnabled == nil || !*report.Subscription.ExtraUsageEnabled) {
				t.Fatalf("lost profile metadata: %+v", report.Subscription)
			}
		})
	}
}

func TestClaudeAccountScopeCapability(t *testing.T) {
	for _, scope := range []any{"user:inference", []any{"user:inference"}, []string{"user:inference"}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("inference-only token must not call account endpoints")
		}))
		report, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{claudeUsage: server.URL, claudeProfile: server.URL}, "test", "claude", map[string]any{"access_token": "token", "scopes": scope}, time.Now())
		server.Close()
		if err != nil || report.Supported || report.Subscription == nil || report.Subscription.ErrorCode != "missing_profile_scope" {
			t.Fatalf("report=%+v err=%v", report, err)
		}
	}
	for _, document := range []map[string]any{{}, {"scope": ""}, {"scope": "user:profile user:inference"}, {"scopes": []any{"user:profile"}}} {
		if claudeMissingProfileScope(document) {
			t.Fatalf("profile scope rejected: %+v", document)
		}
	}
}

func TestClaudeExtraUsageAmounts(t *testing.T) {
	for _, tc := range []struct {
		name, body                      string
		used, limit, remaining, percent *float64
		enabled                         bool
	}{
		{"cents", `{"is_enabled":true,"monthly_limit":10000,"used_credits":1234,"utilization":null}`, float64Ptr(12.34), float64Ptr(100), float64Ptr(87.66), float64Ptr(12.34), true},
		{"unlimited spend", `{"is_enabled":true,"monthly_limit":null,"used_credits":1234}`, float64Ptr(12.34), nil, nil, nil, true},
		{"disabled", `{"is_enabled":false,"monthly_limit":null,"used_credits":null}`, nil, nil, nil, nil, false},
		{"zero limit", `{"is_enabled":true,"monthly_limit":0,"used_credits":0}`, float64Ptr(0), float64Ptr(0), float64Ptr(0), nil, true},
		{"overdrawn", `{"is_enabled":true,"monthly_limit":100,"used_credits":200}`, float64Ptr(2), float64Ptr(1), float64Ptr(0), float64Ptr(100), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			window, ok := claudeExtraUsage(decodeQuotaObject([]byte(tc.body)))
			if !ok || window.Enforceable || window.Enabled == nil || *window.Enabled != tc.enabled || window.Unit != "USD" {
				t.Fatalf("window = %+v", window)
			}
			for name, pair := range map[string][2]*float64{"used": {window.Used, tc.used}, "limit": {window.Limit, tc.limit}, "remaining": {window.Remaining, tc.remaining}, "percent": {window.UsedPercent, tc.percent}} {
				if (pair[0] == nil) != (pair[1] == nil) || pair[0] != nil && math.Abs(*pair[0]-*pair[1]) > 1e-8 {
					t.Fatalf("%s = %v want %v", name, pair[0], pair[1])
				}
			}
		})
	}
}

func TestClaudeNewScopedAndDollarWindows(t *testing.T) {
	now := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"limits":[{"kind":"weekly_scoped","percent":90,"scope":{"model":{"id":"fable"}}},{"kind":"weekly_scoped","is_active":false,"percent":99,"scope":{"model":{"id":"fable"}}},{"kind":"weekly_scoped","is_active":true,"percent":0.5,"resets_at":"2030-01-01T00:00:00Z","scope":{"model":{"id":"fable","display_name":"Fable 5"}}},{"kind":"weekly_scoped","percent":50},{"kind":"unknown","percent":100,"scope":{"model":{"id":"other"}}}],"iguana_necktie":{"limit_dollars":25,"used_dollars":5,"remaining_dollars":20,"utilization":20,"resets_at":"2030-01-01T00:00:00Z"},"unrelated":{"utilization":100}}`))
	}))
	defer server.Close()
	report, err := probeClaudeQuota(t.Context(), server.Client(), server.URL, "test", "claude", map[string]any{"access_token": "token"}, now)
	if err != nil || len(report.Windows) != 2 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	windows := quotaWindowsByKind(report.Windows)
	model := windows["7d-model-fable"]
	dollars := windows["credits-iguana-necktie"]
	if model.UsedPercent == nil || *model.UsedPercent != 0.5 || model.Enforceable || model.Label != "Fable 5 7 天" {
		t.Fatalf("model=%+v", model)
	}
	if dollars.Used == nil || *dollars.Used != 5 || *dollars.Limit != 25 || *dollars.Remaining != 20 || dollars.Unit != "USD" || dollars.Enforceable {
		t.Fatalf("dollars=%+v", dollars)
	}
}

func float64Ptr(value float64) *float64 { return &value }
