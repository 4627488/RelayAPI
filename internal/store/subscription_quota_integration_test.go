package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestSubscriptionQuotasAreBoundToTenantModelsAndGeneration(t *testing.T) {
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
	// A rolled-back transaction isolates this fixture without truncating data.
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	s := Store{DB: tx}
	now := time.Now().UTC().Truncate(time.Second)
	tenantID, keyID, parentID, childID, requestID := identity.NewID(), identity.NewID(), identity.NewID(), identity.NewID(), identity.NewID()
	rows := []any{
		&db.Tenant{ID: tenantID, Name: "quota interop", OwnerEmail: tenantID + "@example.test", PasswordHash: "unused", Enabled: true},
		&db.APIKey{ID: keyID, TenantID: tenantID, Name: "quota interop", KeyHash: []byte(keyID), Enabled: true},
		&db.ParentSubscription{ID: parentID, Name: "private upstream", UpstreamCredentialID: parentID, CapacityMode: db.ParentCapacityObserved, Enabled: true, Status: "available", AllocationLimitPPM: 1000000},
		&db.ChildSubscription{ID: childID, TenantID: tenantID, ParentSubscriptionID: parentID, Name: "user share", ModelAllowlist: []string{"codex-*"}, Enabled: true, StartsAt: now.Add(-time.Hour), AllocationPPM: 100000},
		&db.ParentQuotaWindow{ParentSubscriptionID: parentID, Kind: "7d", LimitNanoUSD: 1000, ResetsAt: now.Add(time.Hour)},
		&db.ChildQuotaWindow{ChildSubscriptionID: childID, Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, StartedAt: now, ResetsAt: now.Add(time.Hour)},
		&db.RequestReservation{RequestID: requestID, TenantID: tenantID, APIKeyID: keyID, ParentSubscriptionID: &parentID, ChildSubscriptionID: &childID, Status: db.ReservationActive, ExpiresAt: now.Add(time.Hour)},
	}
	for _, row := range rows {
		if err = tx.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	key := KeyContext{APIKey: APIKey{ID: keyID, TenantID: tenantID}}
	got, err := s.SubscriptionQuotas(ctx, key, []string{"codex-test", "grok-test"}, now)
	if err != nil || len(got) != 1 || len(got[0].Windows) != 1 || got[0].Windows[0].LimitNanoUSD != 100 || got[0].Windows[0].ReservedNanoUSD != 5 {
		t.Fatalf("quota=%+v err=%v", got, err)
	}
	for _, wrong := range []KeyContext{{APIKey: APIKey{ID: keyID, TenantID: identity.NewID()}}, {APIKey: APIKey{ID: keyID, TenantID: tenantID, ModelAllowlist: []string{"grok-*"}}}} {
		got, err = s.SubscriptionQuotas(ctx, wrong, []string{"codex-test", "grok-test"}, now)
		if err != nil || len(got) != 0 {
			t.Fatalf("cross-identity quota=%+v err=%v", got, err)
		}
	}
	if err = tx.Model(&db.ParentQuotaWindow{}).Where("parent_subscription_id = ?", parentID).Update("resets_at", now.Add(2*time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	got, err = s.SubscriptionQuotas(ctx, key, []string{"codex-test", "grok-test"}, now)
	if err != nil || len(got) != 1 || len(got[0].Windows) != 1 || got[0].Windows[0].SettledNanoUSD != 0 || got[0].Windows[0].ReservedNanoUSD != 0 || !got[0].Windows[0].ResetsAt.Equal(now.Add(2*time.Hour)) {
		t.Fatalf("new generation quota=%+v err=%v", got, err)
	}
	// A never-used sibling must be projected, not hidden until first admission.
	sibling := db.ChildSubscription{ID: identity.NewID(), TenantID: tenantID, ParentSubscriptionID: parentID, Name: "second", Enabled: true, StartsAt: now.Add(-time.Hour), AllocationPPM: 200000, ModelAllowlist: []string{"grok-*"}}
	if err = tx.Create(&sibling).Error; err != nil {
		t.Fatal(err)
	}
	got, err = s.SubscriptionQuotas(ctx, key, []string{"codex-test", "grok-test"}, now)
	if err != nil || len(got) != 2 {
		t.Fatalf("multiple grants=%+v err=%v", got, err)
	}
	restricted := key
	restricted.ModelAllowlist = []string{"grok-*"}
	got, err = s.SubscriptionQuotas(ctx, restricted, []string{"codex-test", "grok-test"}, now)
	if err != nil || len(got) != 1 || got[0].ChildID != sibling.ID || got[0].Windows[0].LimitNanoUSD != 200 {
		t.Fatalf("restricted=%+v err=%v", got, err)
	}
	if err = tx.Model(&sibling).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	got, err = s.SubscriptionQuotas(ctx, restricted, []string{"codex-test", "grok-test"}, now)
	if err != nil || len(got) != 0 {
		t.Fatalf("disabled=%+v err=%v", got, err)
	}
}
