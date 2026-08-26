package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestRAIAuthorizationApproveAndConsume(t *testing.T) {
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
	dataStore, err := New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	email := "rai-store-" + time.Now().UTC().Format("20060102150405.000000000") + "@example.com"
	tenant, err := dataStore.CreateTenant(ctx, "Owner", email, "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	item, interval, err := dataStore.CreateRAIAuthorization(ctx, "laptop", PKCEChallengeS256(verifier), "S256", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if interval < 1 || item.Status != RAIAuthorizationPending {
		t.Fatalf("item = %#v interval=%d", item, interval)
	}
	if _, err := dataStore.ConsumeRAIAuthorization(ctx, item.ID, verifier); err != ErrAuthorizationPending {
		t.Fatalf("pending consume = %v", err)
	}
	if err := dataStore.ApproveRAIAuthorization(ctx, item.ID, tenant.ID); err != nil {
		t.Fatal(err)
	}
	plain, err := dataStore.ConsumeRAIAuthorization(ctx, item.ID, verifier)
	if err != nil || plain == "" {
		t.Fatalf("consume = %q err=%v", plain, err)
	}
	if _, err := dataStore.ConsumeRAIAuthorization(ctx, item.ID, verifier); err != ErrInvalidGrant {
		t.Fatalf("second consume = %v", err)
	}
}
