package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestReservationDoesNotSettleIntoNewQuotaGeneration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := database.Exec(`TRUNCATE request_reservations, child_quota_windows, child_subscriptions,
		parent_quota_observations, parent_quota_windows, parent_subscriptions, billing_ledgers,
		request_logs, api_keys, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	tenantID, keyID := identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{
		ID: tenantID, Name: "integration", OwnerEmail: "integration@example.test",
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 100,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "test", KeyHash: []byte("unique-test-hash"), Prefix: "rk_test", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	store := Store{DB: database}
	parent, err := store.UpsertParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "auth-integration", Name: "parent", CapacityMode: db.ParentCapacityManual,
		AllocationLimitPPM: 1_000_000, Enabled: true, Metadata: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	syncedParent, err := store.SyncParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "scheduler-auth-id", CPAAuthIndex: "auth-integration", CPAAuthName: "auth.json",
		Name: "parent", Provider: "test", CapacityMode: db.ParentCapacityUnmetered,
		AllocationLimitPPM: 1_000_000, Enabled: true, Metadata: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if syncedParent.ID != parent.ID || syncedParent.CPAAuthID != "scheduler-auth-id" || syncedParent.CPAAuthIndex != "auth-integration" {
		t.Fatalf("parent identity mapping was not updated in place: %+v", syncedParent)
	}
	parent = syncedParent
	firstReset := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	if err := store.SetParentQuotaWindows(ctx, parent.ID, []ParentQuotaWindow{{
		Kind: "rolling", LimitNanoUSD: 1_000, ResetsAt: firstReset, Source: "manual",
	}}); err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateChildSubscription(ctx, ChildSubscription{
		TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "child",
		AllocationPPM: 1_000_000, Priority: 100, Enabled: true, StartsAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	requestID := identity.NewID()
	if _, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: requestID,
		Key:       KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}},
		Model:     "model", BalanceReserve: 10, QuotaReserve: 10, PriceConfigured: true,
		PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	secondReset := firstReset.Add(time.Hour)
	if err := database.Model(&db.ChildQuotaWindow{}).
		Where("child_subscription_id = ? AND kind = ?", child.ID, "rolling").
		Updates(map[string]any{"resets_at": secondReset, "settled_nano_usd": 0, "reserved_nano_usd": 0}).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.SettleRequestReservation(ctx, requestID, 7, true); err != nil {
		t.Fatal(err)
	}

	var window db.ChildQuotaWindow
	if err := database.First(&window, "child_subscription_id = ? AND kind = ?", child.ID, "rolling").Error; err != nil {
		t.Fatal(err)
	}
	if !window.ResetsAt.Equal(secondReset) || window.SettledNanoUSD != 0 || window.ReservedNanoUSD != 0 {
		t.Fatalf("new generation was modified: %+v", window)
	}
	var tenant db.Tenant
	if err := database.First(&tenant, "id = ?", tenantID).Error; err != nil {
		t.Fatal(err)
	}
	if tenant.BalanceNanoUSD != 93 {
		t.Fatalf("balance = %d, want 93", tenant.BalanceNanoUSD)
	}

	// Opening the already-migrated schema again must remain idempotent.
	second, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	secondSQL, _ := second.DB()
	_ = secondSQL.Close()
}
