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
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 0,
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
		CPAAuthID: "auth-integration", Name: "parent", CapacityMode: db.ParentCapacityObserved,
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
		Kind: "rolling", LimitNanoUSD: 1_000, ResetsAt: firstReset, Source: db.ParentQuotaSourceManualConversion,
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
	if err := store.SetParentQuotaWindows(ctx, parent.ID, []ParentQuotaWindow{{
		Kind: "rolling", LimitNanoUSD: 2_000, ResetsAt: secondReset, Source: db.ParentQuotaSourceManualConversion,
	}}); err != nil {
		t.Fatal(err)
	}
	var resetWindow db.ChildQuotaWindow
	if err := database.First(&resetWindow, "child_subscription_id = ? AND kind = ?", child.ID, "rolling").Error; err != nil {
		t.Fatal(err)
	}
	if !resetWindow.ResetsAt.Equal(secondReset) || resetWindow.LimitNanoUSD != 2_000 ||
		resetWindow.SettledNanoUSD != 0 || resetWindow.ReservedNanoUSD != 0 {
		t.Fatalf("parent reset was not propagated to child: %+v", resetWindow)
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
	if tenant.BalanceNanoUSD != 0 {
		t.Fatalf("metered subscription changed balance: %d", tenant.BalanceNanoUSD)
	}

	// Opening the already-migrated schema again must remain idempotent.
	second, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	secondSQL, _ := second.DB()
	_ = secondSQL.Close()
}

func TestObservedSubscriptionLearnsBeforeEnforcingQuota(t *testing.T) {
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
		ID: tenantID, Name: "observed", OwnerEmail: "observed@example.test",
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 1_000,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "test", KeyHash: []byte("observed-unique-hash"), Prefix: "rk_observed", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	store := Store{DB: database}
	parent, err := store.SyncParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "observed-auth-id", CPAAuthIndex: "observed-auth-index", CPAAuthName: "observed.json",
		Name: "observed parent", Provider: "extension-provider", CapacityMode: db.ParentCapacityObserved,
		AllocationLimitPPM: 1_000_000, Enabled: true, Metadata: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateChildSubscription(ctx, ChildSubscription{
		TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "observed child",
		AllocationPPM: 1_000_000, Priority: 100, Enabled: true, StartsAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	key := KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}}
	firstID := identity.NewID()
	first, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: firstID, Key: key, Model: "model", BalanceReserve: 10, QuotaReserve: 10,
		PriceConfigured: true, PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.QuotaReservedNanoUSD != 0 || first.CPAAuthID != "observed-auth-id" {
		t.Fatalf("learning admission = %+v", first)
	}
	var firstReservation RequestReservation
	if err := database.First(&firstReservation, "request_id = ?", firstID).Error; err != nil {
		t.Fatal(err)
	}
	if firstReservation.QuotaReservedNanoUSD != 0 || string(firstReservation.QuotaWindows) != "[]" {
		t.Fatalf("learning reservation = %+v", firstReservation)
	}
	if firstReservation.BalanceReservedNanoUSD != 10 {
		t.Fatalf("learning subscription reserved balance: %+v", firstReservation)
	}
	if err := store.SettleRequestReservation(ctx, firstID, 7, true); err != nil {
		t.Fatal(err)
	}
	var learningTenant db.Tenant
	if err := database.First(&learningTenant, "id = ?", tenantID).Error; err != nil {
		t.Fatal(err)
	}
	if learningTenant.BalanceNanoUSD != 993 {
		t.Fatalf("learning subscription balance = %d, want 993", learningTenant.BalanceNanoUSD)
	}
	if err := store.UpdateParentQuotaProbe(ctx, parent.ID, false, "unsupported", "", "", nil, json.RawMessage(`{"supported":false,"windows":[]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: identity.NewID(), Key: key, Model: "model", BalanceReserve: 10, QuotaReserve: 10,
		PriceConfigured: true, PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != ErrSubscriptionExhausted {
		t.Fatalf("unsupported observed provider admission error = %v", err)
	}
	if err := store.UpdateParentQuotaProbe(ctx, parent.ID, true, "supported", "", "", nil, json.RawMessage(`{"supported":true,"windows":[]}`)); err != nil {
		t.Fatal(err)
	}

	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	if err := store.SetParentQuotaWindows(ctx, parent.ID, []ParentQuotaWindow{{
		Kind: "daily", LimitNanoUSD: 100, ResetsAt: reset, Source: db.ParentQuotaSourceManualConversion,
	}}); err != nil {
		t.Fatal(err)
	}
	usedPercent := 25.0
	observedWindowAt := time.Now().UTC()
	if _, err := store.RecordParentQuotaObservation(ctx, parent.ID, "daily", usedPercent, reset, observedWindowAt); err != nil {
		t.Fatal(err)
	}
	configuredWindows, err := store.ListParentQuotaWindows(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(configuredWindows) != 1 || configuredWindows[0].LimitNanoUSD != 100 || configuredWindows[0].Source != db.ParentQuotaSourceManualConversion {
		t.Fatalf("manual USD conversion was overwritten by observation: %+v", configuredWindows)
	}
	second, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: identity.NewID(), Key: key, Model: "model", BalanceReserve: 10, QuotaReserve: 10,
		PriceConfigured: true, PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.QuotaReservedNanoUSD != 10 || second.BalanceReservedNanoUSD != 0 {
		t.Fatalf("enforced admission = %+v", second)
	}

	// The additive migration must expose the automatic probe state on an
	// already-opened schema and preserve a supported result across a transient
	// probe error when the caller supplies the prior capability state.
	observedAt := time.Now().UTC()
	if err := store.UpdateParentQuotaProbe(ctx, parent.ID, true, "supported", "", "pro", &observedAt, json.RawMessage(`{"supported":true,"plan_type":"pro","windows":[{"kind":"daily","used_percent":25}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateParentQuotaProbe(ctx, parent.ID, true, "error", "temporary upstream failure", "", nil, nil); err != nil {
		t.Fatal(err)
	}
	updated, err := store.GetParentSubscription(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.QuotaSupported || updated.QuotaProbeStatus != "error" || updated.QuotaObservedAt == nil || updated.PlanType != "pro" {
		t.Fatalf("updated probe state = %+v", updated)
	}
	var snapshot struct {
		Windows []struct {
			Kind string `json:"kind"`
		} `json:"windows"`
	}
	if err := json.Unmarshal(updated.QuotaSnapshot, &snapshot); err != nil {
		t.Fatalf("decode retained quota snapshot: %v (%s)", err, updated.QuotaSnapshot)
	}
	if len(snapshot.Windows) != 1 || snapshot.Windows[0].Kind != "daily" {
		t.Fatalf("quota snapshot was not retained across a transient error: %s", updated.QuotaSnapshot)
	}
}

func TestModelWithoutChildAssignmentFallsBackToTenantBalance(t *testing.T) {
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
		ID: tenantID, Name: "balance fallback", OwnerEmail: "balance-fallback@example.test",
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 100,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "test", KeyHash: []byte("balance-fallback-unique-hash"),
		Prefix: "rk_fallback", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	store := Store{DB: database}
	parent, err := store.SyncParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "subscription-auth", CPAAuthIndex: "subscription-index", CPAAuthName: "subscription.json",
		Name: "subscription parent", Provider: "test", CapacityMode: db.ParentCapacityUnmetered,
		AllocationLimitPPM: 1_000_000, Enabled: true, CPAModelAllowlist: []string{"subscription-model"},
		Metadata: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateChildSubscription(ctx, ChildSubscription{
		TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "subscription child",
		AllocationPPM: 1_000_000, Priority: 100, Enabled: true,
		ModelAllowlist: []string{"subscription-model"}, StartsAt: time.Now().Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	key := KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}}
	requestID := identity.NewID()
	admission, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: requestID, Key: key, Model: "payg-model", BalanceReserve: 10, QuotaReserve: 10,
		PriceConfigured: true, PriceSnapshot: json.RawMessage(`{"model":"payg-model"}`),
		ExpiresAt: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if admission.CPAAuthID != "" || admission.ChildSubscriptionID != "" || admission.BalanceReservedNanoUSD != 10 {
		t.Fatalf("balance fallback admission = %+v", admission)
	}
	if err := store.SettleRequestReservation(ctx, requestID, 7, true); err != nil {
		t.Fatal(err)
	}
	var tenant db.Tenant
	if err := database.First(&tenant, "id = ?", tenantID).Error; err != nil {
		t.Fatal(err)
	}
	if tenant.BalanceNanoUSD != 93 {
		t.Fatalf("balance = %d, want 93", tenant.BalanceNanoUSD)
	}

	assigned, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: identity.NewID(), Key: key, Model: "subscription-model", BalanceReserve: 10, QuotaReserve: 10,
		PriceConfigured: true, PriceSnapshot: json.RawMessage(`{"model":"subscription-model"}`),
		ExpiresAt: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if assigned.CPAAuthID != "subscription-auth" || assigned.ChildSubscriptionID == "" || assigned.BalanceReservedNanoUSD != 10 {
		t.Fatalf("assigned admission = %+v", assigned)
	}
}
