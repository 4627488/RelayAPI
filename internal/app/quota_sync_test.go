package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestQuotaProbeUnauthorized(t *testing.T) {
	if quotaProbeUnauthorized(nil) {
		t.Fatal("nil error")
	}
	if !quotaProbeUnauthorized(errors.New(`Kimi quota requests failed: kimi-cn-usage: upstream returned HTTP 401: {"error":{"reason":"REASON_INVALID_AUTH_TOKEN"}}`)) {
		t.Fatal("expected 401")
	}
	if quotaProbeUnauthorized(errors.New("upstream returned HTTP 404: url.not_found")) {
		t.Fatal("404 is not unauthorized")
	}
}

func TestRefreshQuotaCredentialDocumentUsesRuntimeToken(t *testing.T) {
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "refresh_token=old-refresh") {
			t.Errorf("form = %s", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600})
	}))
	defer oauth.Close()

	var persisted []byte
	runtime, err := upstream.NewRuntime(upstream.Options{
		OnCredentialUpdated: func(_ context.Context, _ string, document []byte) {
			persisted = append([]byte(nil), document...)
		},
	}, []upstream.Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: mustJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "old-access",
			"refresh_token":  "old-refresh",
			"expired":        time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	application := &App{nativeRuntime: runtime}
	stale := mustJSON(t, map[string]any{"type": "kimi", "access_token": "old-access", "refresh_token": "old-refresh"})
	document := application.refreshQuotaCredentialDocument(t.Context(), "kimi-1", stale, false)
	var payload map[string]any
	if json.Unmarshal(document, &payload) != nil || payload["access_token"] != "new-access" {
		t.Fatalf("document = %s", document)
	}
	if string(persisted) != string(document) {
		t.Fatalf("persist = %s", persisted)
	}
}

func TestProbeQuotaWithRefreshRetriesAfter401(t *testing.T) {
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access", "expires_in": 3600})
	}))
	defer oauth.Close()

	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: mustJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "still-valid-access",
			"refresh_token":  "refresh",
			"expired":        time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	var tokens []string
	reset := time.Now().UTC().Add(2 * time.Hour)
	probe := func(_ context.Context, credential gateway.QuotaProbeCredential) (gateway.QuotaReport, error) {
		var document map[string]any
		if json.Unmarshal(credential.Document, &document) != nil {
			t.Fatalf("document = %s", credential.Document)
		}
		token, _ := document["access_token"].(string)
		tokens = append(tokens, token)
		if token != "new-access" {
			return gateway.QuotaReport{}, errors.New("upstream returned HTTP 401: REASON_INVALID_AUTH_TOKEN")
		}
		used := 10.0
		return gateway.QuotaReport{
			AuthIndex: credential.AuthIndex, Provider: "kimi", Supported: true, Observed: time.Now().UTC(),
			Windows: []gateway.QuotaWindow{{Kind: "5h", UsedPercent: &used, ResetsAt: &reset, Enforceable: true}},
		}, nil
	}

	application := &App{nativeRuntime: runtime}
	report, err := application.probeQuotaWithRefreshFn(t.Context(), store.ParentSubscription{
		UpstreamCredentialID: "kimi-1", Provider: "kimi",
	}, store.UpstreamCredentialSnapshot{
		ID: "kimi-1", Provider: "kimi",
		Document: mustJSON(t, map[string]any{"type": "kimi", "access_token": "still-valid-access"}),
	}, "", probe)
	if err != nil || !report.Supported || len(tokens) != 2 || tokens[0] != "still-valid-access" || tokens[1] != "new-access" {
		t.Fatalf("report = %#v tokens=%v err=%v", report, tokens, err)
	}
}

func TestProbeQuotaWithRefreshRefreshesExpiredTokenBeforeFirstProbe(t *testing.T) {
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access", "expires_in": 3600})
	}))
	defer oauth.Close()

	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{{
		ID: "kimi-1", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: mustJSON(t, map[string]any{
			"type":           "kimi",
			"access_token":   "old-access",
			"refresh_token":  "refresh",
			"expired":        time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
			"token_endpoint": oauth.URL,
		}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	var tokens []string
	probe := func(_ context.Context, credential gateway.QuotaProbeCredential) (gateway.QuotaReport, error) {
		var document map[string]any
		_ = json.Unmarshal(credential.Document, &document)
		token, _ := document["access_token"].(string)
		tokens = append(tokens, token)
		used := 1.0
		reset := time.Now().UTC().Add(time.Hour)
		return gateway.QuotaReport{Supported: true, Observed: time.Now().UTC(), Windows: []gateway.QuotaWindow{{Kind: "5h", UsedPercent: &used, ResetsAt: &reset, Enforceable: true}}}, nil
	}

	application := &App{nativeRuntime: runtime}
	_, err = application.probeQuotaWithRefreshFn(t.Context(), store.ParentSubscription{UpstreamCredentialID: "kimi-1", Provider: "kimi"}, store.UpstreamCredentialSnapshot{
		ID: "kimi-1", Document: mustJSON(t, map[string]any{"access_token": "old-access"}),
	}, "", probe)
	if err != nil || len(tokens) != 1 || tokens[0] != "new-access" {
		t.Fatalf("tokens = %v err=%v", tokens, err)
	}
}
