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

func TestMissingParentCleanupReleasesReservationsAndDeletesCurrentState(t *testing.T) {
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
	if err = database.Exec(`TRUNCATE web_socket_turns, request_reservations, child_quota_windows, child_subscriptions,
		parent_quota_observations, parent_quota_windows, parent_subscriptions, billing_ledgers,
		request_logs, api_keys, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	tenantID, keyID := identity.NewID(), identity.NewID()
	if err = database.Create(&db.Tenant{
		ID: tenantID, Name: "cleanup", OwnerEmail: "cleanup@example.test",
		PasswordHash: "test", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err = database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "cleanup", KeyHash: []byte("cleanup-hash"), Prefix: "rk_cleanup", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	dataStore := Store{DB: database}
	lastSync := time.Now().Add(-time.Minute)
	parent, err := dataStore.SyncNativeParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "deleted-credential", Name: "deleted", Provider: "codex", Status: "available",
		CapacityMode: db.ParentCapacityObserved, AllocationLimitPPM: 1_000_000,
		Enabled: true, Metadata: json.RawMessage(`{}`), LastSyncedAt: &lastSync,
	})
	if err != nil {
		t.Fatal(err)
	}
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	if err = dataStore.SetParentQuotaWindows(ctx, parent.ID, []ParentQuotaWindow{{
		Kind: "rolling", LimitNanoUSD: 1_000, ResetsAt: reset,
	}}); err != nil {
		t.Fatal(err)
	}
	child, err := dataStore.CreateChildSubscription(ctx, ChildSubscription{
		TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "deleted child",
		AllocationPPM: 1_000_000, Priority: 100, Enabled: true, StartsAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	requestID := identity.NewID()
	if _, err = dataStore.AdmitRequest(ctx, AdmissionInput{
		RequestID: requestID, Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}},
		Model: "model", QuotaReserve: 10, PriceConfigured: true,
		PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err = dataStore.MarkMissingParentSubscriptions(ctx, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	var parentCount, childCount int64
	if err = database.Model(&db.ParentSubscription{}).Where("id = ?", parent.ID).Count(&parentCount).Error; err != nil {
		t.Fatal(err)
	}
	if err = database.Model(&db.ChildSubscription{}).Where("id = ?", child.ID).Count(&childCount).Error; err != nil {
		t.Fatal(err)
	}
	if parentCount != 0 || childCount != 0 {
		t.Fatalf("missing subscription state survived cleanup: parents=%d children=%d", parentCount, childCount)
	}
	var reservation db.RequestReservation
	if err = database.First(&reservation, "request_id = ?", requestID).Error; err != nil {
		t.Fatal(err)
	}
	if reservation.Status != db.ReservationReleased || reservation.ActualNanoUSD == nil || *reservation.ActualNanoUSD != 0 || reservation.ParentSubscriptionID != nil || reservation.ChildSubscriptionID != nil {
		t.Fatalf("reservation was not released at zero cost: %+v", reservation)
	}
	if err = dataStore.SettleRequestReservation(ctx, requestID, 999, true); err != nil {
		t.Fatal(err)
	}
	if err = database.First(&reservation, "request_id = ?", requestID).Error; err != nil {
		t.Fatal(err)
	}
	if reservation.Status != db.ReservationReleased || reservation.ActualNanoUSD == nil || *reservation.ActualNanoUSD != 0 {
		t.Fatalf("late settlement changed a released dead subscription: %+v", reservation)
	}
}

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

func TestWebSocketTurnAccrualSurvivesExpiryAndIsIdempotent(t *testing.T) {
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
	if err := database.Exec(`TRUNCATE web_socket_turns, request_reservations, child_quota_windows, child_subscriptions,
		parent_quota_observations, parent_quota_windows, parent_subscriptions, billing_ledgers,
		request_logs, api_keys, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	tenantID, keyID, requestID := identity.NewID(), identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{
		ID: tenantID, Name: "websocket", OwnerEmail: "websocket@example.test",
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 100,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "test", KeyHash: []byte("websocket-unique-hash"),
		Prefix: "rk_ws", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	store := Store{DB: database}
	if _, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: requestID, Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}},
		Model: "model", BalanceReserve: 10, QuotaReserve: 10, PriceConfigured: true,
		PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	log := LogInput{
		ID: requestID, TenantID: tenantID, APIKeyID: keyID, ReservationRequestID: requestID,
		Model: "model", ActualModel: "model",
		Method: "GET", Path: "/v1/responses", RequestType: "responses.websocket", StatusCode: 101,
		Stream: true, PricingComplete: true, Settled: true, Usage: Usage{Prompt: 20, Completion: 10, Total: 30},
		CostNanoUSD: int64Pointer(25), ReservedNanoUSD: 10, StartedAt: time.Now(), CompletedAt: time.Now(),
	}
	input := WebSocketTurnAccrual{
		RequestID: requestID, TurnID: "resp_1", Usage: log.Usage, CostNanoUSD: 25,
		PricingComplete: true, Log: log,
	}
	inserted, err := store.AccrueWebSocketTurn(ctx, input)
	if err != nil || !inserted {
		t.Fatalf("first accrual inserted=%v, err=%v", inserted, err)
	}
	inserted, err = store.AccrueWebSocketTurn(ctx, input)
	if err != nil || inserted {
		t.Fatalf("duplicate accrual inserted=%v, err=%v", inserted, err)
	}
	secondLog := log
	secondLog.ID = identity.NewID()
	secondLog.Model, secondLog.ActualModel = "model-2", "model-2"
	secondLog.Usage = Usage{Prompt: 4, Completion: 3, Total: 7}
	secondLog.CostNanoUSD = int64Pointer(7)
	secondInput := input
	secondInput.TurnID = "resp_2"
	secondInput.Usage = secondLog.Usage
	secondInput.CostNanoUSD = 7
	secondInput.Log = secondLog
	inserted, err = store.AccrueWebSocketTurn(ctx, secondInput)
	if err != nil || !inserted {
		t.Fatalf("second accrual inserted=%v, err=%v", inserted, err)
	}

	var tenant db.Tenant
	if err := database.First(&tenant, "id = ?", tenantID).Error; err != nil {
		t.Fatal(err)
	}
	if tenant.BalanceNanoUSD != 58 {
		t.Fatalf("balance while reserve is held = %d, want 58", tenant.BalanceNanoUSD)
	}
	var reservation RequestReservation
	if err := database.First(&reservation, "request_id = ?", requestID).Error; err != nil {
		t.Fatal(err)
	}
	if reservation.ActualNanoUSD == nil || *reservation.ActualNanoUSD != 32 || reservation.Status != db.ReservationActive {
		t.Fatalf("active reservation = %+v", reservation)
	}
	var requestLogs []db.RequestLog
	if err := database.Where("id IN ?", []string{requestID, secondLog.ID}).Order("model").Find(&requestLogs).Error; err != nil {
		t.Fatal(err)
	}
	if len(requestLogs) != 2 || requestLogs[0].Model != "model" || requestLogs[0].TotalTokens != 30 ||
		requestLogs[0].CostNanoUSD == nil || *requestLogs[0].CostNanoUSD != 25 ||
		requestLogs[1].Model != "model-2" || requestLogs[1].TotalTokens != 7 ||
		requestLogs[1].CostNanoUSD == nil || *requestLogs[1].CostNanoUSD != 7 ||
		requestLogs[1].ReservationRequestID == nil || *requestLogs[1].ReservationRequestID != requestID {
		t.Fatalf("per-entry websocket logs = %+v", requestLogs)
	}

	reclaimed, err := store.ReclaimExpiredReservations(ctx, time.Now().Add(2*time.Minute))
	if err != nil || reclaimed != 1 {
		t.Fatalf("reclaimed=%d, err=%v", reclaimed, err)
	}
	if err := database.First(&tenant, "id = ?", tenantID).Error; err != nil {
		t.Fatal(err)
	}
	if tenant.BalanceNanoUSD != 68 {
		t.Fatalf("balance after expiry = %d, want 68", tenant.BalanceNanoUSD)
	}
	if err := database.First(&reservation, "request_id = ?", requestID).Error; err != nil {
		t.Fatal(err)
	}
	if reservation.Status != db.ReservationExpired || reservation.ActualNanoUSD == nil || *reservation.ActualNanoUSD != 32 {
		t.Fatalf("expired reservation lost accrued usage: %+v", reservation)
	}
	var turns int64
	if err := database.Model(&db.WebSocketTurn{}).Where("request_id = ?", requestID).Count(&turns).Error; err != nil {
		t.Fatal(err)
	}
	if turns != 2 {
		t.Fatalf("turn rows = %d, want 2", turns)
	}

	parent, err := store.SyncParentSubscription(ctx, ParentSubscription{
		CPAAuthID: "ws-auth-id", CPAAuthIndex: "ws-auth-index", CPAAuthName: "ws.json",
		Name: "ws parent", Provider: "test", CapacityMode: db.ParentCapacityObserved,
		AllocationLimitPPM: 1_000_000, Enabled: true, Metadata: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	if err := store.SetParentQuotaWindows(ctx, parent.ID, []ParentQuotaWindow{{
		Kind: "daily", LimitNanoUSD: 1_000, ResetsAt: reset, Source: db.ParentQuotaSourceManualConversion,
	}}); err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateChildSubscription(ctx, ChildSubscription{
		TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "ws child",
		AllocationPPM: 1_000_000, Priority: 100, Enabled: true, StartsAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	quotaRequestID := identity.NewID()
	if _, err := store.AdmitRequest(ctx, AdmissionInput{
		RequestID: quotaRequestID, Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}},
		Model: "model", BalanceReserve: 10, QuotaReserve: 10, PriceConfigured: true,
		PriceSnapshot: json.RawMessage(`{"model":"model"}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	quotaLog := log
	quotaLog.ID = quotaRequestID
	quotaLog.ReservationRequestID = quotaRequestID
	quotaInput := input
	quotaInput.RequestID = quotaRequestID
	quotaInput.TurnID = "resp_quota"
	quotaInput.Log = quotaLog
	inserted, err = store.AccrueWebSocketTurn(ctx, quotaInput)
	if err != nil || !inserted {
		t.Fatalf("quota accrual inserted=%v, err=%v", inserted, err)
	}
	var window db.ChildQuotaWindow
	if err := database.First(&window, "child_subscription_id = ? AND kind = ?", child.ID, "daily").Error; err != nil {
		t.Fatal(err)
	}
	if window.ReservedNanoUSD != 10 || window.SettledNanoUSD != 25 {
		t.Fatalf("quota after terminal accrual = %+v", window)
	}
	if err := store.SettleRequestReservation(ctx, quotaRequestID, 25, true); err != nil {
		t.Fatal(err)
	}
	if err := database.First(&window, "child_subscription_id = ? AND kind = ?", child.ID, "daily").Error; err != nil {
		t.Fatal(err)
	}
	if window.ReservedNanoUSD != 0 || window.SettledNanoUSD != 25 {
		t.Fatalf("quota finalization double-counted a durable turn: %+v", window)
	}
}

func int64Pointer(value int64) *int64 { return &value }
