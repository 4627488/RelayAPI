package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexResetCreditsHTTPContract(t *testing.T) {
	var redeemed []CodexResetConsumeInput
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("ChatGPT-Account-ID") != "account-1" {
			t.Error("missing Codex authentication headers")
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /wham/rate-limit-reset-credits":
			// available_count is authoritative even when the detail list is partial.
			w.Write([]byte(`{"available_count":3,"credits":[{"id":"credit-1","reset_type":"codex_rate_limits","status":"available","granted_at":"2026-09-01T00:00:00Z","expires_at":"2026-10-01T00:00:00Z","title":"Reset","profile_user_id":"private-profile"},{"id":"credit-2","reset_type":"codex_rate_limits","status":"available","granted_at":"2026-09-01T00:00:00Z","expires_at":null}]}`))
		case "POST /wham/rate-limit-reset-credits/consume":
			if r.Header.Get("Content-Type") != "application/json" {
				t.Error("missing JSON content type")
			}
			var input CodexResetConsumeInput
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			redeemed = append(redeemed, input)
			w.Write([]byte(`{"code":"already_redeemed","windows_reset":2,"credit":{"secret":"not forwarded"}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	endpoint := server.URL + "/wham/rate-limit-reset-credits"
	headers := codexQuotaHeaders("test-token", "account-1")
	var details CodexResetCredits
	if err := requestCodexResetCredits(t.Context(), server.Client(), endpoint, headers, nil, &details); err != nil {
		t.Fatal(err)
	}
	if details.AvailableCount == nil || *details.AvailableCount != 3 || len(details.Credits) != 2 || details.Credits[0].ExpiresAt == nil || details.Credits[1].ExpiresAt != nil {
		t.Fatalf("details = %+v", details)
	}
	encoded, _ := json.Marshal(details)
	if strings.Contains(string(encoded), "private-profile") {
		t.Fatal("forwarded unrelated upstream metadata")
	}
	input := &CodexResetConsumeInput{RedeemRequestID: "same-retry-id", CreditID: "credit-1"}
	for range 2 {
		var result CodexResetConsumeResult
		if err := requestCodexResetCredits(t.Context(), server.Client(), endpoint, headers, input, &result); err != nil {
			t.Fatal(err)
		}
		if result.Code != "already_redeemed" || result.WindowsReset != 2 {
			t.Fatalf("result = %+v", result)
		}
	}
	if len(redeemed) != 2 || redeemed[0] != redeemed[1] || redeemed[0] != *input {
		t.Fatalf("retry changed request: %+v", redeemed)
	}
}

func TestCodexResetCreditsDoesNotLeakUpstreamErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "secret-token", http.StatusUnauthorized)
	}))
	defer server.Close()
	var result CodexResetCredits
	err := requestCodexResetCredits(t.Context(), server.Client(), server.URL, http.Header{}, nil, &result)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("err = %v", err)
	}
}

func TestCodexResetCreditsRejectsUnsupportedCredentials(t *testing.T) {
	for _, credential := range []QuotaProbeCredential{
		{Provider: "openai", Document: []byte(`{"api_key":"secret"}`)},
		{Provider: "codex", Document: []byte(`{"api_key":"secret"}`)},
		{Provider: "codex", Document: []byte(`{"access_token":"secret"}`)},
	} {
		if _, err := ReadCodexResetCredits(t.Context(), credential); err == nil {
			t.Fatal("accepted unsupported credential")
		}
	}
}
