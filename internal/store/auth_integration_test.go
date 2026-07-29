package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestFirstRegisteredUserBecomesAdministrator(t *testing.T) {
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
		request_logs, api_keys, invitations, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	store := Store{DB: database}
	setupRequired, err := store.SetupRequired(ctx)
	if err != nil || !setupRequired {
		t.Fatalf("initial setup status = %v, %v", setupRequired, err)
	}

	admin, err := store.Register(ctx, "", "First User", "first@example.com", "password123")
	if err != nil {
		t.Fatal(err)
	}
	if !admin.IsAdmin {
		t.Fatalf("first user was not promoted: %+v", admin)
	}
	if setupRequired, err = store.SetupRequired(ctx); err != nil || setupRequired {
		t.Fatalf("setup status after first user = %v, %v", setupRequired, err)
	}
	if _, err := store.Register(ctx, "", "No Invite", "second@example.com", "password123"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("registration without invitation after setup = %v", err)
	}

	_, token, err := store.CreateInvitation(ctx, "member@example.com", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	member, err := store.Register(ctx, token, "Member", "member@example.com", "password123")
	if err != nil {
		t.Fatal(err)
	}
	if member.IsAdmin {
		t.Fatalf("invited user unexpectedly became administrator: %+v", member)
	}
}
