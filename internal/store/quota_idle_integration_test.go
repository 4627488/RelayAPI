package store

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestClaudeIdleAdmissionPreservesWeeklyQuotaAndRestartsFiveHourWindow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := t.Context()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	defer sqlDB.Close()
	tenantID, keyID := identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{ID: tenantID, Name: "idle test", OwnerEmail: tenantID + "@example.test", PasswordHash: "test", Enabled: true, BalanceNanoUSD: 1000}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{ID: keyID, TenantID: tenantID, Name: "idle test", KeyHash: []byte(keyID), Prefix: "rk_idle", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	s := Store{DB: database}
	parent, err := s.SyncNativeParentSubscription(ctx, ParentSubscription{UpstreamCredentialID: identity.NewID(), Name: "idle Claude", Provider: "claude", CapacityMode: db.ParentCapacityObserved, AllocationLimitPPM: 1_000_000, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateChildSubscription(ctx, ChildSubscription{TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "idle child", AllocationPPM: 1_000_000, Enabled: true, StartsAt: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	oldReset, weeklyReset := time.Now().Add(-time.Hour).UTC(), time.Now().Add(24*time.Hour).UTC()
	// Insert the expired generation directly: the admin setter correctly rejects
	// already-expired windows, but production retains them after a reset.
	for _, window := range []ParentQuotaWindow{
		{ParentSubscriptionID: parent.ID, Kind: "5h", LimitNanoUSD: 100, ResetsAt: oldReset, Source: db.ParentQuotaSourceManualConversion},
		{ParentSubscriptionID: parent.ID, Kind: "7d", LimitNanoUSD: 1000, ResetsAt: weeklyReset, Source: db.ParentQuotaSourceManualConversion},
	} {
		if err := database.Create(&window).Error; err != nil {
			t.Fatal(err)
		}
	}
	admit := func() (Admission, error) {
		return s.AdmitRequest(ctx, AdmissionInput{RequestID: identity.NewID(), Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}}, Model: "claude", BalanceReserve: 10, QuotaReserve: 10, PriceConfigured: true, ExpiresAt: time.Now().Add(time.Minute)})
	}
	if _, err := admit(); err != ErrSubscriptionUnavailable {
		t.Fatalf("without evidence: %v", err)
	}
	observed := time.Now().UTC()
	snapshot, _ := json.Marshal(map[string]any{"source": "claude-oauth-usage", "supported": true, "observed_at": observed, "windows": []any{map[string]any{"kind": "5h", "used_percent": 0, "resets_at": nil, "enforceable": false}}})
	if err := s.UpdateParentQuotaProbe(ctx, parent.ID, true, "supported", "", "", &observed, snapshot); err != nil {
		t.Fatal(err)
	}
	admission, err := admit()
	if err != nil {
		t.Fatalf("idle window still blocks: %v", err)
	}
	var reservation RequestReservation
	if err := database.First(&reservation, "request_id = ?", admission.RequestID).Error; err != nil {
		t.Fatal(err)
	}
	var windows []quotaWindowReservation
	if err := json.Unmarshal(reservation.QuotaWindows, &windows); err != nil {
		t.Fatal(err)
	}
	if len(windows) != 1 || windows[0].Kind != "7d" || reservation.QuotaReservedNanoUSD != 10 || reservation.BalanceReservedNanoUSD != 0 {
		t.Fatalf("weekly enforcement lost: %+v %+v", reservation, windows)
	}
	if err := s.SettleRequestReservation(ctx, admission.RequestID, 10, true); err != nil {
		t.Fatal(err)
	}
	_, err = s.AdmitRequest(ctx, AdmissionInput{RequestID: identity.NewID(), Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}}, Model: "claude", QuotaReserve: 1001, PriceConfigured: true, ExpiresAt: time.Now().Add(time.Minute)})
	if err != ErrSubscriptionExhausted {
		t.Fatalf("idle five-hour window bypassed weekly exhaustion: %v", err)
	}
	// The first new upstream observation advances the original row and keeps its
	// manual conversion; a stale idle snapshot cannot bypass a future reset.
	newReset := time.Now().Add(5 * time.Hour).UTC()
	if _, err := s.RecordParentQuotaObservation(ctx, parent.ID, "5h", 1, newReset, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	admission, err = admit()
	if err != nil {
		t.Fatal(err)
	}
	reservation = RequestReservation{}
	if err := database.First(&reservation, "request_id = ?", admission.RequestID).Error; err != nil {
		t.Fatal(err)
	}
	windows = nil
	if err := json.Unmarshal(reservation.QuotaWindows, &windows); err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("new 5h generation not enforced: %+v", windows)
	}
}
