package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

type quotaRefreshRuntime struct {
	upstream.Runtime
	refresh func(context.Context, string, bool) ([]byte, bool, error)
}

func (r quotaRefreshRuntime) RefreshCredential(ctx context.Context, id string, force bool) ([]byte, bool, error) {
	return r.refresh(ctx, id, force)
}

func TestQuotaRefreshFailureIsVisibleAndRetryIsBounded(t *testing.T) {
	for _, refreshFails := range []bool{false, true} {
		t.Run(fmt.Sprint(refreshFails), func(t *testing.T) {
			refreshErr := errors.New("invalid_grant")
			forced, probes := 0, 0
			application := &App{nativeRuntime: quotaRefreshRuntime{refresh: func(_ context.Context, id string, force bool) ([]byte, bool, error) {
				if id != "kimi-1" {
					t.Fatalf("id=%s", id)
				}
				if force {
					forced++
					if refreshFails {
						return nil, false, refreshErr
					}
				}
				return []byte(`{"access_token":"runtime-token"}`), force, nil
			}}}
			_, err := application.probeQuotaWithRefreshFn(t.Context(), store.ParentSubscription{UpstreamCredentialID: "kimi-1", Provider: "kimi"}, store.UpstreamCredentialSnapshot{ID: "kimi-1", Document: []byte(`{"access_token":"old"}`)}, "", func(_ context.Context, input gateway.QuotaProbeCredential) (gateway.QuotaReport, error) {
				probes++
				if string(input.Document) != `{"access_token":"runtime-token"}` {
					t.Fatal("probe used stale database document")
				}
				return gateway.QuotaReport{}, errors.New("upstream returned HTTP 401")
			})
			wantProbes := 2
			if refreshFails {
				wantProbes = 1
				if !errors.Is(err, refreshErr) {
					t.Fatalf("refresh failure hidden: %v", err)
				}
			}
			if err == nil || forced != 1 || probes != wantProbes {
				t.Fatalf("forced=%d probes=%d err=%v", forced, probes, err)
			}
		})
	}
}

func TestQuotaProbeUnauthorized(t *testing.T) {
	if quotaProbeUnauthorized(nil) {
		t.Fatal("nil error")
	}
	if !quotaProbeUnauthorized(errors.New(`Kimi quota requests failed: kimi-cn-usage: upstream returned HTTP 401: {"error":{"reason":"REASON_INVALID_AUTH_TOKEN"}}`)) {
		t.Fatal("expected kimi 401")
	}
	if !quotaProbeUnauthorized(errors.New("codex quota request: upstream returned HTTP 401: invalid_token")) {
		t.Fatal("expected codex 401")
	}
	if !quotaProbeUnauthorized(errors.New("xAI quota requests failed: credits: upstream returned HTTP 401: unauthorized")) {
		t.Fatal("expected xai 401")
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

func TestProbeQuotaWithRefreshCoversCodexAndXAI(t *testing.T) {
	for _, provider := range []string{"codex", "xai"} {
		t.Run(provider, func(t *testing.T) {
			oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				if r.Form.Get("grant_type") != "refresh_token" {
					t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
				}
				if provider == "codex" && r.Form.Get("scope") != "openid profile email" {
					t.Errorf("codex scope = %q", r.Form.Get("scope"))
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"access_token": provider + "-access", "expires_in": 3600})
			}))
			defer oauth.Close()

			runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{{
				ID: provider + "-1", Provider: provider, Enabled: true, Models: []string{"model"},
				Document: mustJSON(t, map[string]any{
					"type": provider, "access_token": "old-access", "refresh_token": "refresh",
					"expired": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), "token_endpoint": oauth.URL,
					"account_id": "acct_1",
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
				used := 3.0
				reset := time.Now().UTC().Add(time.Hour)
				return gateway.QuotaReport{Supported: true, Provider: provider, Observed: time.Now().UTC(), Windows: []gateway.QuotaWindow{{Kind: "5h", UsedPercent: &used, ResetsAt: &reset, Enforceable: true}}}, nil
			}

			application := &App{nativeRuntime: runtime}
			_, err = application.probeQuotaWithRefreshFn(t.Context(), store.ParentSubscription{UpstreamCredentialID: provider + "-1", Provider: provider}, store.UpstreamCredentialSnapshot{
				ID: provider + "-1", Provider: provider, Document: mustJSON(t, map[string]any{"access_token": "old-access"}),
			}, "", probe)
			if err != nil || len(tokens) != 1 || tokens[0] != provider+"-access" {
				t.Fatalf("tokens = %v err=%v", tokens, err)
			}
		})
	}
}

func TestQuotaSubscriptionSnapshotPreservesUsageObservation(t *testing.T) {
	previous := json.RawMessage(`{"supported":true,"plan_type":"max","observed_at":"2026-10-01T00:00:00Z","windows":[{"kind":"5h","used_percent":100,"resets_at":"2026-10-01T01:00:00Z","enforceable":true}]}`)
	for _, status := range []string{"supported", "error"} {
		report := gateway.QuotaReport{PlanType: "pro", Subscription: &gateway.QuotaSubscription{Status: status, Source: "claude-oauth-profile"}}
		encoded := quotaSubscriptionSnapshot(previous, report)
		var snapshot gateway.QuotaReport
		if err := json.Unmarshal(encoded, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Observed.Format(time.RFC3339) != "2026-10-01T00:00:00Z" || len(snapshot.Windows) != 1 || *snapshot.Windows[0].UsedPercent != 100 || !snapshot.Supported {
			t.Fatalf("usage changed on failed probe: %s", encoded)
		}
		wantPlan := "max"
		if status == "supported" {
			wantPlan = "pro"
		}
		if snapshot.PlanType != wantPlan || snapshot.Subscription.Status != status {
			t.Fatalf("metadata=%s", encoded)
		}
	}
	if got := quotaSubscriptionSnapshot(previous, gateway.QuotaReport{}); got != nil {
		t.Fatalf("non-subscription probes must preserve existing behavior: %s", got)
	}
	for _, previous := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`{}`)} {
		encoded := quotaSubscriptionSnapshot(previous, gateway.QuotaReport{PlanType: "max", Subscription: &gateway.QuotaSubscription{Status: "supported"}})
		var snapshot gateway.QuotaReport
		if err := json.Unmarshal(encoded, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Supported || !snapshot.Observed.IsZero() || len(snapshot.Windows) != 0 || snapshot.PlanType != "max" {
			t.Fatalf("invented usage: %s", encoded)
		}
	}
}
