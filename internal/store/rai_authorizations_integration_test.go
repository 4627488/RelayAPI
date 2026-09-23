package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
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
	item, interval, err := dataStore.CreateRAIAuthorization(ctx, "laptop", PKCEChallengeS256(verifier), "S256", time.Now(), RAIDeviceMetadata{DeviceOS: "windows", DeviceArch: "amd64", RAIVersion: "test-version"})
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
	// A manually named key must not be classified by a display-name prefix.
	manual, _, err := dataStore.CreateKey(ctx, tenant.ID, "rai · manually created", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := dataStore.ListManualKeys(ctx, tenant.ID)
	if err != nil || len(keys) != 1 || keys[0].ID != manual.ID {
		t.Fatalf("manual keys=%+v err=%v", keys, err)
	}
	if _, err := dataStore.DeleteExpiredRAIAuthorizations(ctx, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	devices, err := dataStore.ListRAIDevices(ctx, tenant.ID)
	if err != nil || len(devices) != 1 {
		t.Fatalf("devices=%+v err=%v", devices, err)
	}
	device := devices[0]
	if device.DeviceName != "laptop" || device.DeviceOS != "windows" || device.DeviceArch != "amd64" || device.RAIVersion != "test-version" {
		t.Fatalf("device=%+v", device)
	}
	if err := dataStore.RevokeRAIDevice(ctx, identity.NewID(), device.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant revocation: %v", err)
	}
	if err := dataStore.RevokeRAIDevice(ctx, tenant.ID, manual.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked manual key: %v", err)
	}
	if _, err := dataStore.RevealKey(ctx, tenant.ID, device.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("exposed device secret: %v", err)
	}
	if err := dataStore.RevokeRAIDevice(ctx, tenant.ID, device.ID); err != nil {
		t.Fatal(err)
	}
	resolved, err := dataStore.ResolveKey(ctx, plain)
	if err != nil || resolved.Enabled {
		t.Fatalf("revoked credential remains enabled: %v", err)
	}
	if _, err := dataStore.UpdateKey(ctx, tenant.ID, device.ID, "reenable", true, nil, nil, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reactivated device through manual key API: %v", err)
	}
}
