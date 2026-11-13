package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestOAuthFinalizeReplacesQuotaLifecycle(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	s, err := store.New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	for _, failQuota := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh quota", true: "quota failure keeps authorization"}[failQuota], func(t *testing.T) {
			id := "codex-" + identity.NewID()
			t.Cleanup(func() {
				if err := database.Exec("DELETE FROM parent_subscriptions WHERE upstream_credential_id = ?", id).Error; err != nil {
					t.Error(err)
				}
				if err := s.DeleteUpstreamCredential(context.Background(), id); err != nil {
					t.Error(err)
				}
			})
			oldExpiry := time.Now().Add(-time.Hour)
			oldDocument := json.RawMessage(`{"type":"codex","access_token":"old","expired":"2030-01-01T00:00:00Z"}`)
			_, err := s.UpsertUpstreamCredential(t.Context(), store.UpstreamCredentialInput{ID: id, Name: "Codex", Provider: "codex", Enabled: true, Models: []string{"codex-test"}, Source: "oauth", Document: oldDocument, ExpiresAt: &oldExpiry})
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := upstream.NewRuntime(upstream.Options{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = runtime.Close(context.Background()) })
			a := &App{store: s, nativeRuntime: runtime, providerOAuth: newProviderOAuthSessions()}
			parents, err := a.syncNativeParentSubscriptionRows(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			var parent store.ParentSubscription
			for _, p := range parents {
				if p.UpstreamCredentialID == id {
					parent = p
				}
			}
			observed := time.Now().Add(-time.Minute)
			if err = s.UpdateParentQuotaProbe(t.Context(), parent.ID, true, "supported", "", "pro", &observed, json.RawMessage(`{"supported":true,"plan_type":"pro","windows":[{"kind":"7d","used_percent":16}]}`)); err != nil {
				t.Fatal(err)
			}
			a.quotaBackoff.begin(id, time.Now())
			a.quotaBackoff.finish(id, time.Now(), &gateway.QuotaHTTPError{StatusCode: 401}, "codex")
			if failQuota {
				a.nativeRuntime = quotaRefreshRuntime{Runtime: a.nativeRuntime, refresh: func(context.Context, string, bool) ([]byte, bool, error) {
					return nil, false, errors.New("upstream temporarily unavailable")
				}}
			}
			session := a.providerOAuth.create("codex", id)
			a.providerOAuth.bindState(session.ID, "state-"+id)
			newDocument := []byte(`{"type":"codex","access_token":"new","expired":"2030-01-02T00:00:00Z","last_refresh":"2026-11-09T08:27:22Z","relay_quota":{"plan_type":"max","windows":[{"kind":"7d","used_percent":0}]}}`)
			if err = a.providerOAuth.capture(session.ID, "codex", "Codex", newDocument); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/finalize", strings.NewReader(`{"name":"Codex"}`))
			r.SetPathValue("state", "state-"+id)
			w := httptest.NewRecorder()
			a.adminProviderOAuthFinalize(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("finalize=%d %s", w.Code, w.Body.String())
			}
			var response struct {
				Quota quotaSyncResult `json:"quota_sync"`
			}
			if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			want := "supported"
			if failQuota {
				want = "error"
			}
			if response.Quota.Status != want {
				t.Fatalf("quota=%+v", response.Quota)
			}
			credential, err := s.GetUpstreamCredential(t.Context(), id)
			if err != nil || !strings.Contains(string(credential.Document), `"access_token":"new"`) || credential.ExpiresAt != nil {
				t.Fatalf("new authorization not retained: %v %+v", err, credential)
			}
			updated, err := s.GetParentSubscription(t.Context(), parent.ID)
			if err != nil {
				t.Fatal(err)
			}
			if updated.QuotaProbeStatus != want {
				t.Fatalf("durable probe=%+v", updated)
			}
			if !failQuota && (updated.PlanType != "max" || !updated.QuotaObservedAt.After(observed)) {
				t.Fatalf("old plan/cache survived reauthorization: %+v", updated)
			}
			if !failQuota {
				// This batch held a parent snapshot from before reauthorization.
				cached := a.syncParentQuota(t.Context(), parent)
				if cached.Status != "supported" || cached.ObservedAt.Before(*updated.QuotaObservedAt) {
					t.Fatalf("old batch restored stale quota: %+v", cached)
				}
			}
			if _, found := a.providerOAuth.snapshotByState("state-" + id); found {
				t.Fatal("finalized session retained secrets")
			}
		})
	}
}
