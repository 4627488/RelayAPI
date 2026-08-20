package upstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCredentialTokenNeedsRefresh(t *testing.T) {
	now := time.Date(2026, 8, 20, 3, 0, 0, 0, time.UTC)
	tests := []struct {
		name         string
		refreshToken string
		expiresAt    time.Time
		want         bool
	}{
		{name: "no refresh token", expiresAt: now.Add(-time.Hour)},
		{name: "missing expiry", refreshToken: "refresh", want: true},
		{name: "already expired", refreshToken: "refresh", expiresAt: now.Add(-time.Minute), want: true},
		{name: "inside lead window", refreshToken: "refresh", expiresAt: now.Add(4 * time.Minute), want: true},
		{name: "still valid", refreshToken: "refresh", expiresAt: now.Add(20 * time.Minute)},
	}
	for _, test := range tests {
		if got := credentialTokenNeedsRefresh(test.refreshToken, test.expiresAt, now); got != test.want {
			t.Fatalf("%s: got %v, want %v", test.name, got, test.want)
		}
	}
}

func TestRefreshCredentialRefreshesExpiredKimiToken(t *testing.T) {
	var persisted []byte
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-Msh-Device-Id") != "device-1" {
			t.Errorf("oauth request %s device=%q", r.Method, r.Header.Get("X-Msh-Device-Id"))
		}
		body, _ := io.ReadAll(r.Body)
		form := string(body)
		if !strings.Contains(form, "grant_type=refresh_token") || !strings.Contains(form, "refresh_token=old-refresh") {
			t.Errorf("form = %s", form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "new-access",
			"refresh_token": "new-refresh",
			"expires_in":    3600,
		})
	}))
	defer oauth.Close()

	runtime, err := NewRuntime(Options{
		OnCredentialUpdated: func(_ context.Context, id string, document []byte) {
			if id != "kimi-1" {
				t.Errorf("persisted id = %q", id)
			}
			persisted = append([]byte(nil), document...)
		},
	}, []Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: testJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "old-access",
			"refresh_token":  "old-refresh",
			"device_id":      "device-1",
			"expired":        time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	document, refreshed, err := runtime.RefreshCredential(t.Context(), "kimi-1", false)
	if err != nil || !refreshed {
		t.Fatalf("refresh = %v refreshed=%v", err, refreshed)
	}
	var payload map[string]any
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "new-access" || payload["refresh_token"] != "new-refresh" {
		t.Fatalf("document = %s", document)
	}
	if string(persisted) != string(document) {
		t.Fatalf("persisted = %s, document = %s", persisted, document)
	}
}

func TestRefreshCredentialSkipsFreshTokenUnlessForced(t *testing.T) {
	var oauthHits int
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		oauthHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "forced-access", "expires_in": 3600})
	}))
	defer oauth.Close()

	runtime, err := NewRuntime(Options{}, []Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: testJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "fresh-access",
			"refresh_token":  "fresh-refresh",
			"expired":        time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	document, refreshed, err := runtime.RefreshCredential(t.Context(), "kimi-1", false)
	if err != nil || refreshed || oauthHits != 0 {
		t.Fatalf("fresh refresh = %v refreshed=%v hits=%d", err, refreshed, oauthHits)
	}
	var payload map[string]any
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "fresh-access" {
		t.Fatalf("document = %s", document)
	}

	document, refreshed, err = runtime.RefreshCredential(t.Context(), "kimi-1", true)
	if err != nil || !refreshed || oauthHits != 1 {
		t.Fatalf("forced refresh = %v refreshed=%v hits=%d", err, refreshed, oauthHits)
	}
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "forced-access" {
		t.Fatalf("forced document = %s", document)
	}
}

func TestRefreshCredentialRefreshesWhenExpiryMissing(t *testing.T) {
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "issued-access", "expires_in": 1800})
	}))
	defer oauth.Close()

	runtime, err := NewRuntime(Options{}, []Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: testJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "stale-access",
			"refresh_token":  "keep-refresh",
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	document, refreshed, err := runtime.RefreshCredential(t.Context(), "kimi-1", false)
	if err != nil || !refreshed {
		t.Fatalf("refresh = %v refreshed=%v", err, refreshed)
	}
	var payload map[string]any
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "issued-access" || payload["refresh_token"] != "keep-refresh" {
		t.Fatalf("document = %s", document)
	}
	if strings.TrimSpace(fmtString(payload["expired"])) == "" {
		t.Fatalf("expired was not written: %#v", payload)
	}
}

func fmtString(value any) string {
	text, _ := value.(string)
	return text
}
