package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func TestBundledQuotaAdapterPackIsDeclarative(t *testing.T) {
	adapters, err := loadQuotaAdapters("append", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(adapters) < 2 {
		t.Fatalf("bundled adapters = %d, want at least 2", len(adapters))
	}
	if _, ok := matchQuotaAdapter(adapters, "codex-oauth"); !ok {
		t.Fatal("bundled manifest must declare the codex-oauth alias")
	}
	if _, ok := matchQuotaAdapter(adapters, "x-ai"); !ok {
		t.Fatal("bundled manifest must declare the x-ai alias")
	}
	if _, ok := matchQuotaAdapter(adapters, "openai"); ok {
		t.Fatal("generic OpenAI credentials must not be hard-coded as Codex OAuth")
	}
}

func TestBundledAdapterDerivesWindowKindsAndExpandsArrays(t *testing.T) {
	original := hostCallback
	t.Cleanup(func() { hostCallback = original })
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	adapters, err := loadQuotaAdapters("append", nil)
	if err != nil {
		t.Fatal(err)
	}
	adapter, ok := matchQuotaAdapter(adapters, "codex")
	if !ok {
		t.Fatal("missing bundled adapter")
	}
	hostCallback = func(method string, payload any) (json.RawMessage, error) {
		if method != hostHTTPDo {
			t.Fatalf("unexpected method %q", method)
		}
		body := []byte(`{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":6,"reset_at":1785926400,"limit_window_seconds":604800},"secondary_window":{"used_percent":2,"reset_at":1785348000,"limit_window_seconds":18000}},"additional_rate_limits":[{"limit_name":"GPT-5 Mini","rate_limit":{"primary_window":{"used_percent":10,"reset_at":1785348000}}}]}`)
		raw, _ := json.Marshal(hostHTTPResponse{StatusCode: 200, Body: body})
		return raw, nil
	}
	report, err := runQuotaAdapter(adapter, map[string]any{"access_token": "secret", "account_id": "account"}, now)
	if err != nil {
		t.Fatal(err)
	}
	byKind := map[string]quotaWindow{}
	for _, window := range report.Windows {
		byKind[window.Kind] = window
	}
	if byKind["7d"].UsedPercent == nil || *byKind["7d"].UsedPercent != 6 || !byKind["7d"].Enforceable {
		t.Fatalf("7d window = %+v", byKind["7d"])
	}
	if byKind["5h"].UsedPercent == nil || *byKind["5h"].UsedPercent != 2 || !byKind["5h"].Enforceable {
		t.Fatalf("5h window = %+v", byKind["5h"])
	}
	if byKind["gpt-5-mini-primary"].UsedPercent == nil || byKind["gpt-5-mini-primary"].Enforceable {
		t.Fatalf("additional window = %+v", byKind["gpt-5-mini-primary"])
	}
}

func TestCustomAdapterRunsForArbitraryProviderWithoutLeakingSecrets(t *testing.T) {
	original := hostCallback
	t.Cleanup(func() { hostCallback = original })
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	adapters, err := loadQuotaAdapters("replace", []quotaAdapter{{
		ID: "nebula-quota", Providers: []string{"nebula-ai"}, Source: "community/nebula",
		Requests: []quotaAdapterRequest{
			{ID: "usage", URL: "https://quota.nebula.invalid/usage", Headers: map[string]string{"Authorization": "Bearer ${auth.secret.token}"}},
			{ID: "account", URL: "https://quota.nebula.invalid/account/${auth.account}", Optional: true},
		},
		Plan: &quotaValueSpec{Request: "account", Path: "tier", Map: map[string]string{"2": "pro"}},
		Windows: []quotaWindowSpec{
			{Kind: "rolling", Label: "Rolling", Request: "usage", UsedValuePath: "usage.spent", LimitValuePath: "usage.limit", ResetPath: "usage.resets_in", Enforceable: true},
			{Kind: "credits", Request: "account", RemainingRawPath: "credits.remaining", LimitPath: "credits.limit", Unit: "credits"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var upstreamCalls int
	hostCallback = func(method string, payload any) (json.RawMessage, error) {
		switch method {
		case hostAuthGetRuntime:
			return json.RawMessage(`{"auth":{"auth_index":"idx-nebula","provider":"Nebula_AI","type":"oauth"}}`), nil
		case hostAuthGet:
			return json.RawMessage(`{"auth_index":"idx-nebula","json":{"secret":{"token":"do-not-leak"},"account":"acct-private"}}`), nil
		case hostHTTPDo:
			upstreamCalls++
			rawRequest, _ := json.Marshal(payload)
			var request hostHTTPRequest
			_ = json.Unmarshal(rawRequest, &request)
			var body []byte
			if strings.HasSuffix(request.URL, "/usage") {
				if !strings.Contains(string(rawRequest), "do-not-leak") {
					t.Fatalf("adapter did not receive rendered credential: %s", rawRequest)
				}
				body = []byte(`{"usage":{"spent":25,"limit":100,"resets_in":"2h"}}`)
			} else {
				body = []byte(`{"tier":2,"credits":{"remaining":40,"limit":50}}`)
			}
			raw, _ := json.Marshal(hostHTTPResponse{StatusCode: 200, Body: body})
			return raw, nil
		default:
			t.Fatalf("unexpected host method %q", method)
			return nil, nil
		}
	}
	report, status, err := probeQuota("idx-nebula", adapters, now)
	if err != nil || status != 200 {
		t.Fatalf("probe = status %d err %v", status, err)
	}
	if upstreamCalls != 2 || !report.Supported || report.Provider != "nebula-ai" || report.PlanType != "pro" || report.Source != "community/nebula" {
		t.Fatalf("report = %+v, calls = %d", report, upstreamCalls)
	}
	if len(report.Windows) != 2 {
		t.Fatalf("windows = %+v", report.Windows)
	}
	byKind := map[string]quotaWindow{}
	for _, window := range report.Windows {
		byKind[window.Kind] = window
	}
	if byKind["rolling"].UsedPercent == nil || math.Abs(*byKind["rolling"].UsedPercent-25) > 0.0001 || byKind["rolling"].ResetsAt == nil {
		t.Fatalf("rolling window = %+v", byKind["rolling"])
	}
	if byKind["credits"].Remaining == nil || *byKind["credits"].Remaining != 40 || byKind["credits"].Limit == nil || *byKind["credits"].Limit != 50 {
		t.Fatalf("credits window = %+v", byKind["credits"])
	}
	raw, _ := json.Marshal(report)
	if strings.Contains(string(raw), "do-not-leak") || strings.Contains(string(raw), "acct-private") {
		t.Fatalf("normalized report leaked credential material: %s", raw)
	}
}

func TestOptionalRequestsAndWindowMappings(t *testing.T) {
	original := hostCallback
	t.Cleanup(func() { hostCallback = original })
	hostCallback = func(method string, payload any) (json.RawMessage, error) {
		if method != hostHTTPDo {
			t.Fatalf("unexpected host method %q", method)
		}
		rawRequest, _ := json.Marshal(payload)
		if strings.Contains(string(rawRequest), "optional.invalid") {
			return nil, errTest("optional endpoint unavailable")
		}
		raw, _ := json.Marshal(hostHTTPResponse{StatusCode: 200, Body: []byte(`{"remaining":72.5,"reset":1785326400000}`)})
		return raw, nil
	}
	adapter := quotaAdapter{
		ID: "generic", Providers: []string{"*"}, Requests: []quotaAdapterRequest{
			{ID: "optional", URL: "https://optional.invalid", Optional: true},
			{ID: "required", URL: "https://required.invalid"},
		},
		Windows: []quotaWindowSpec{
			{Kind: "ignored", Request: "optional", UsedPercentPath: "used"},
			{Kind: "daily", Request: "required", RemainingPath: "remaining", ResetPath: "reset", Enforceable: true},
		},
	}
	report, err := runQuotaAdapter(adapter, map[string]any{}, time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Windows) != 1 || report.Windows[0].UsedPercent == nil || *report.Windows[0].UsedPercent != 27.5 || report.Windows[0].ResetsAt == nil {
		t.Fatalf("report = %+v", report)
	}
}

func TestAdapterModesAndOverride(t *testing.T) {
	if adapters, err := loadQuotaAdapters("disabled", []quotaAdapter{{}}); err != nil || len(adapters) != 0 {
		t.Fatalf("disabled adapters = %+v, err = %v", adapters, err)
	}
	custom := quotaAdapter{
		ID: "codex-wham", Providers: []string{"custom-provider"},
		Requests: []quotaAdapterRequest{{ID: "quota", URL: "https://example.invalid/quota"}},
		Windows:  []quotaWindowSpec{{Kind: "daily", Request: "quota", UsedPercentPath: "used"}},
	}
	adapters, err := loadQuotaAdapters("append", []quotaAdapter{custom})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := matchQuotaAdapter(adapters, "codex"); ok {
		t.Fatal("custom adapter with the same id must replace the bundled definition")
	}
	matched, ok := matchQuotaAdapter(adapters, "custom-provider")
	if !ok || matched.ID != "codex-wham" {
		t.Fatalf("matched = %+v, ok = %v", matched, ok)
	}
	replaced, err := loadQuotaAdapters("replace", []quotaAdapter{custom})
	if err != nil || len(replaced) != 1 {
		t.Fatalf("replace adapters = %+v, err = %v", replaced, err)
	}
}

func TestWildcardAdapterAndInvalidManifestValidation(t *testing.T) {
	wildcard := quotaAdapter{
		ID: "fallback", Providers: []string{"*"},
		Requests: []quotaAdapterRequest{{ID: "quota", URL: "https://example.invalid/quota"}},
		Windows:  []quotaWindowSpec{{Kind: "daily", Request: "quota", UsedPercentPath: "used"}},
	}
	adapters, err := loadQuotaAdapters("replace", []quotaAdapter{wildcard})
	if err != nil {
		t.Fatal(err)
	}
	if matched, ok := matchQuotaAdapter(adapters, "future-provider"); !ok || matched.ID != "fallback" {
		t.Fatalf("wildcard matched = %+v, ok = %v", matched, ok)
	}
	invalid := wildcard
	invalid.ID = "invalid-plan"
	invalid.Plan = &quotaValueSpec{Request: "missing", Path: "tier"}
	if _, err := loadQuotaAdapters("replace", []quotaAdapter{invalid}); err == nil {
		t.Fatal("manifest with an unknown plan request must fail during registration")
	}
}

func TestEmbeddedQuotaExtensionWorksForAnyProvider(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	report, ok := embeddedQuotaReport(map[string]any{"relay_quota": map[string]any{
		"plan_type": "enterprise",
		"windows": []any{map[string]any{
			"kind": "monthly", "remaining_percent": 80.0, "resets_at": now.Add(24 * time.Hour).Format(time.RFC3339), "enforceable": true,
		}},
	}}, "community-provider", "idx", now)
	if !ok || !report.Supported || report.Source != "cpa-auth-extension" || len(report.Windows) != 1 || report.Windows[0].UsedPercent == nil || *report.Windows[0].UsedPercent != 20 {
		t.Fatalf("report = %+v, ok = %v", report, ok)
	}
}

func TestUnsupportedProviderReturnsCapabilityResult(t *testing.T) {
	original := hostCallback
	t.Cleanup(func() { hostCallback = original })
	hostCallback = func(method string, payload any) (json.RawMessage, error) {
		switch method {
		case hostAuthGetRuntime:
			return json.RawMessage(`{"auth":{"auth_index":"idx-2","provider":"gemini"}}`), nil
		case hostAuthGet:
			return json.RawMessage(`{"auth_index":"idx-2","json":{"type":"gemini","access_token":"secret"}}`), nil
		default:
			t.Fatalf("unsupported provider must not issue upstream call: %s", method)
			return nil, nil
		}
	}
	report, status, err := probeQuota("idx-2", nil, time.Now())
	if err != nil || status != 200 || report.Supported || report.Provider != "gemini" {
		t.Fatalf("report/status/error = %+v/%d/%v", report, status, err)
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }
