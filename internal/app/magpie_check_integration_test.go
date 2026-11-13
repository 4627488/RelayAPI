package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestMagpieCheckUsesKeyScopeAndNormalSettlement(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := database.DB()
	defer conn.Close()
	tx := database.Begin()
	defer tx.Rollback()
	s, err := store.New(tx, "magpie-check-test-encryption-key-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	tenantID := identity.NewID()
	tenant := db.Tenant{ID: tenantID, Name: "Magpie", OwnerEmail: tenantID + "@example.test", PasswordHash: "unused", Enabled: true, BalanceNanoUSD: 100000}
	if err = tx.Create(&tenant).Error; err != nil {
		t.Fatal(err)
	}
	key, _, err := s.CreateKey(t.Context(), tenantID, "laptop", nil, nil, []string{"check-model"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpsertPrice(t.Context(), store.Price{Model: "check-model", InputNanoUSDPerToken: 2, CachedInputNanoUSDPerToken: 1, OutputNanoUSDPerToken: 3, PriceMultiplier: 1}); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/responses" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"response-check","status":"completed","model":"check-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4},"output_tokens":5}}`))
	}))
	defer backend.Close()
	a := newNativeRuntimeTestApp(t, upstream.Credential{ID: "magpie-check", Provider: "codex", Enabled: true, Models: []string{"check-model", "private-model"}, Document: mustJSON(t, map[string]any{"api_key": "fake-upstream-key", "base_url": backend.URL})})
	a.cfg = config.Config{PublicURL: "https://relay.example", MaxRequestBytes: 1 << 20, ReservationNanoUSD: 100}
	a.store = s
	a.finalizationSlots = make(chan struct{}, 1)
	a.nativeAdmission.Store(gateway.New(gateway.Options{MaxInFlight: 2}))
	request := func(path, tenantID, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.SetPathValue("id", key.ID)
		req = req.WithContext(context.WithValue(req.Context(), sessionKey, identity.Session{TenantID: tenantID}))
		rec := httptest.NewRecorder()
		a.magpieCheck(rec, req)
		a.wg.Wait()
		return rec
	}
	free := request("/api/keys/"+key.ID+"/magpie/check", tenantID, `{"generate":false}`)
	var result magpieCheckResult
	if free.Code != 200 || json.Unmarshal(free.Body.Bytes(), &result) != nil {
		t.Fatalf("free: %d %s", free.Code, free.Body)
	}
	if calls.Load() != 0 || len(result.Models) != 1 || result.Models[0] != "check-model" || result.Checks[3].Status != "skipped" {
		t.Fatalf("free check escaped model scope or generated: %+v calls=%d", result, calls.Load())
	}
	denied := request("/api/keys/"+key.ID+"/magpie/check", identity.NewID(), `{"generate":true}`)
	if denied.Code != 404 || calls.Load() != 0 {
		t.Fatalf("cross-tenant access: %d", denied.Code)
	}
	invalid := request("/api/keys/"+key.ID+"/magpie/check", tenantID, `{"generate":true,"model":"private-model"}`)
	if invalid.Code != 200 || calls.Load() != 0 {
		t.Fatalf("unauthorized generation: %d calls=%d", invalid.Code, calls.Load())
	}
	generated := request("/api/keys/"+key.ID+"/magpie/check", tenantID, `{"generate":true,"model":"check-model"}`)
	result = magpieCheckResult{}
	if generated.Code != 200 || json.Unmarshal(generated.Body.Bytes(), &result) != nil || calls.Load() != 1 || result.RequestID == "" || result.Checks[3].Status != "ok" {
		t.Fatalf("generation: %d %s calls=%d", generated.Code, generated.Body, calls.Load())
	}
	var reservation db.RequestReservation
	if err = tx.First(&reservation, "request_id = ?", result.RequestID).Error; err != nil {
		t.Fatal(err)
	}
	if reservation.Status != db.ReservationSettled {
		t.Fatalf("probe not settled normally: %+v", reservation)
	}
	updated, err := s.GetTenant(t.Context(), tenantID)
	if err != nil || updated.BalanceNanoUSD != 100000-31 {
		t.Fatalf("wrong disjoint cache charge: balance=%d err=%v", updated.BalanceNanoUSD, err)
	}
	// Unavailable upstream grants remain visible instead of becoming 'no plan'.
	parentID, childID := identity.NewID(), identity.NewID()
	if err = tx.Create(&db.ParentSubscription{ID: parentID, UpstreamCredentialID: parentID, Name: "private", CapacityMode: db.ParentCapacityObserved, Enabled: true, UpstreamUnavailable: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err = tx.Create(&db.ChildSubscription{ID: childID, ParentSubscriptionID: parentID, TenantID: tenantID, Name: "visible outage", Enabled: true, StartsAt: time.Now().Add(-time.Hour), AllocationPPM: 100000}).Error; err != nil {
		t.Fatal(err)
	}
	quotas, err := s.SubscriptionQuotas(t.Context(), store.KeyContext{APIKey: key}, []string{"check-model"}, time.Now())
	if err != nil || len(quotas) != 1 || !quotas[0].Unavailable {
		t.Fatalf("outage disappeared: %+v %v", quotas, err)
	}
}
