package upstream

import (
	"context"
	"encoding/base64"
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
	status, ok := runtime.CredentialStatus("kimi-1")
	if !ok || status.LastRefreshedAt.IsZero() || time.Since(status.LastRefreshedAt) > time.Minute {
		t.Fatalf("last refreshed = %+v ok=%v", status, ok)
	}
}

func TestRefreshDueCredentialsRenewsExpiredTokens(t *testing.T) {
	var oauthHits int
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		oauthHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "due-access", "refresh_token": "due-refresh", "expires_in": 3600})
	}))
	defer oauth.Close()

	runtime, err := NewRuntime(Options{}, []Credential{
		{
			ID: "kimi-stale", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
			Document: testJSON(t, map[string]any{
				"type": "kimi", "access_token": "old", "refresh_token": "refresh",
				"expired": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), "token_endpoint": oauth.URL,
			}),
		},
		{
			ID: "kimi-fresh", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
			Document: testJSON(t, map[string]any{
				"type": "kimi", "access_token": "fresh", "refresh_token": "refresh",
				"expired": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "token_endpoint": oauth.URL,
			}),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	refreshed, failed := runtime.RefreshDueCredentials(t.Context())
	if refreshed != 1 || failed != 0 || oauthHits != 1 {
		t.Fatalf("due refresh refreshed=%d failed=%d hits=%d", refreshed, failed, oauthHits)
	}
	document, did, err := runtime.RefreshCredential(t.Context(), "kimi-stale", false)
	if err != nil || did {
		t.Fatalf("stale after renew = %v did=%v", err, did)
	}
	var payload map[string]any
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "due-access" {
		t.Fatalf("stale document = %s", document)
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

func TestRefreshCredentialRefreshesCodexAndXAI(t *testing.T) {
	now := time.Now()
	codexJWT := testJWT(t, map[string]any{
		"email":                       "user@example.com",
		"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct_refreshed"},
	})
	xaiJWT := testJWT(t, map[string]any{"email": "grok@example.com", "sub": "user-22", "exp": now.Add(2 * time.Hour).Unix()})

	tests := []struct {
		name     string
		id       string
		provider string
		document map[string]any
		wantForm []string
		check    func(*testing.T, http.Header, map[string]any)
		response map[string]any
	}{
		{
			name: "codex sends CPA scope and updates account id",
			id:   "codex-1", provider: "codex",
			document: map[string]any{
				"type": "codex", "access_token": "old-access", "refresh_token": "old-refresh",
				"account_id": "acct_old", "expired": now.Add(-time.Hour).UTC().Format(time.RFC3339),
			},
			wantForm: []string{"grant_type=refresh_token", "client_id=" + codexClientID, "refresh_token=old-refresh", "scope=openid+profile+email"},
			response: map[string]any{"access_token": "codex-access", "refresh_token": "codex-refresh", "id_token": codexJWT, "expires_in": 3600},
			check: func(t *testing.T, _ http.Header, payload map[string]any) {
				t.Helper()
				if payload["access_token"] != "codex-access" || payload["account_id"] != "acct_refreshed" || payload["email"] != "user@example.com" {
					t.Fatalf("codex payload = %#v", payload)
				}
			},
		},
		{
			name: "xai uses default token URL and persists it",
			id:   "xai-1", provider: "xai",
			document: map[string]any{
				"type": "xai", "access_token": "old-access", "refresh_token": "old-refresh",
				"expired": now.Add(-time.Hour).UTC().Format(time.RFC3339),
			},
			wantForm: []string{"grant_type=refresh_token", "client_id=" + xaiClientID, "refresh_token=old-refresh"},
			response: map[string]any{"access_token": "xai-access", "id_token": xaiJWT},
			check: func(t *testing.T, header http.Header, payload map[string]any) {
				t.Helper()
				if header.Get("X-Msh-Device-Id") != "" {
					t.Fatalf("xAI refresh sent Kimi headers: %v", header)
				}
				if payload["access_token"] != "xai-access" || payload["sub"] != "user-22" || payload["email"] != "grok@example.com" {
					t.Fatalf("xai payload = %#v", payload)
				}
				if payload["token_endpoint"] == "" || payload["expired"] == "" {
					t.Fatalf("xai did not persist endpoint/expiry: %#v", payload)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var header http.Header
			oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				header = r.Header.Clone()
				body, _ := io.ReadAll(r.Body)
				form := string(body)
				for _, part := range test.wantForm {
					if !strings.Contains(form, part) {
						t.Errorf("form %q missing %q", form, part)
					}
				}
				_ = json.NewEncoder(w).Encode(test.response)
			}))
			defer oauth.Close()
			test.document["token_endpoint"] = oauth.URL
			runtime, err := NewRuntime(Options{}, []Credential{{
				ID: test.id, Provider: test.provider, Enabled: true, Models: []string{"model"},
				Document: testJSON(t, test.document),
			}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = runtime.Close(t.Context()) })
			document, refreshed, err := runtime.RefreshCredential(t.Context(), test.id, false)
			if err != nil || !refreshed {
				t.Fatalf("refresh = %v refreshed=%v", err, refreshed)
			}
			var payload map[string]any
			if json.Unmarshal(document, &payload) != nil {
				t.Fatal(document)
			}
			test.check(t, header, payload)
		})
	}
}

func TestOauthExpiryUsesExpiresInOrJWT(t *testing.T) {
	now := time.Date(2026, 8, 20, 4, 0, 0, 0, time.UTC)
	if got := oauthExpiry(map[string]any{"expires_in": json.Number("90")}, "", now); !got.Equal(now.Add(90 * time.Second)) {
		t.Fatalf("expires_in = %v", got)
	}
	token := testJWT(t, map[string]any{"exp": now.Add(45 * time.Minute).Unix()})
	if got := oauthExpiry(map[string]any{}, token, now); got.Before(now.Add(44*time.Minute)) || got.After(now.Add(46*time.Minute)) {
		t.Fatalf("jwt exp = %v", got)
	}
	if got := oauthExpiry(map[string]any{}, "", now); !got.Equal(now.Add(time.Hour)) {
		t.Fatalf("default = %v", got)
	}
}

func TestOauthTokenEndpointDefaults(t *testing.T) {
	if got := oauthTokenEndpoint("xai", nil); got != xaiTokenURL {
		t.Fatalf("xai default = %q", got)
	}
	if got := oauthTokenEndpoint("codex", map[string]any{"token_endpoint": "https://auth.example/token"}); got != "https://auth.example/token" {
		t.Fatalf("override = %q", got)
	}
	if got := oauthRefreshForm("codex", "rt").Get("scope"); got != codexRefreshScope {
		t.Fatalf("codex scope = %q", got)
	}
	if oauthRefreshForm("xai", "rt").Get("scope") != "" {
		t.Fatal("xAI refresh should not send Codex scope")
	}
}

func fmtString(value any) string {
	text, _ := value.(string)
	return text
}

func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}
