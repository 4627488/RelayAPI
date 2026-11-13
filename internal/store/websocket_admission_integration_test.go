package store

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestKeptWebSocketChecksQuotaAndWindowGeneration(t *testing.T) {
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
	s := Store{DB: tx}
	tenant, id := identity.NewID(), identity.NewID()
	if err = tx.Create(&db.Tenant{ID: tenant, Name: "ws", OwnerEmail: tenant + "@example.test", PasswordHash: "unused", Enabled: true, BalanceNanoUSD: 10000}).Error; err != nil {
		t.Fatal(err)
	}
	if err = tx.Create(&db.APIKey{ID: id, TenantID: tenant, Name: "ws", KeyHash: []byte(id), Prefix: "test", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	parent, err := s.UpsertParentSubscription(t.Context(), ParentSubscription{UpstreamCredentialID: identity.NewID(), Name: "ws", Enabled: true, Status: "available", CapacityMode: db.ParentCapacityObserved})
	if err != nil {
		t.Fatal(err)
	}
	reset := time.Now().Add(time.Hour)
	if err = tx.Create(&db.ParentQuotaWindow{ParentSubscriptionID: parent.ID, Kind: "5h", LimitNanoUSD: 1000, ResetsAt: reset}).Error; err != nil {
		t.Fatal(err)
	}
	child := db.ChildSubscription{ID: identity.NewID(), TenantID: tenant, ParentSubscriptionID: parent.ID, Name: "ws", Enabled: true, StartsAt: time.Now().Add(-time.Hour), AllocationPPM: 1000000}
	if err = tx.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	key := KeyContext{APIKey: APIKey{ID: id, TenantID: tenant}, TenantBalance: 10000}
	admission, err := s.AdmitRequest(t.Context(), AdmissionInput{RequestID: identity.NewID(), Key: key, Model: "model", QuotaReserve: 100, PriceConfigured: true, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.CheckWebSocketTurn(t.Context(), key, admission, "model"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Model(&db.ChildQuotaWindow{}).Where("child_subscription_id = ?", child.ID).Update("settled_nano_usd", 1001).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.CheckWebSocketTurn(t.Context(), key, admission, "model"); !errors.Is(err, ErrSubscriptionExhausted) {
		t.Fatalf("quota bypass on kept socket: %v", err)
	}
	if err = tx.Model(&db.ParentQuotaWindow{}).Where("parent_subscription_id = ?", parent.ID).Update("resets_at", reset.Add(time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.CheckWebSocketTurn(t.Context(), key, admission, "model"); !errors.Is(err, ErrWebSocketReconnect) {
		t.Fatalf("old reservation reused after reset: %v", err)
	}
	if err = tx.Model(&db.ChildSubscription{}).Where("id = ?", child.ID).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.CheckWebSocketTurn(t.Context(), key, admission, "model"); !errors.Is(err, ErrSubscriptionUnavailable) {
		t.Fatalf("revoked subscription accepted: %v", err)
	}
}
