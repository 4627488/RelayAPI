package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestResolveKeyJoinTouchDebounceAndDailyTokenCounters(t *testing.T) {
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
	if err := database.Exec(`TRUNCATE request_log_details, request_reservations, request_logs,
		api_key_model_aliases, api_keys, invitations, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	plain, prefix, hash := identity.NewAPIKey()
	tenantID, keyID := identity.NewID(), identity.NewID()
	limit := int64(1_000)
	if err := database.Create(&db.Tenant{
		ID: tenantID, Name: "Hotpath User", OwnerEmail: "hotpath@example.test",
		PasswordHash: "test", Enabled: true, TokenLimitDaily: &limit,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "Hotpath Key",
		KeyHash: hash, Prefix: prefix, Enabled: true, TokenLimitDaily: &limit,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKeyModelAlias{
		ID: identity.NewID(), APIKeyID: keyID, Alias: "friendly-model", Model: "actual-model",
	}).Error; err != nil {
		t.Fatal(err)
	}

	dataStore := Store{DB: database, keyTouches: newKeyTouchState()}
	resolved, err := dataStore.ResolveKey(ctx, plain)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ID != keyID || resolved.TenantName != "Hotpath User" || !resolved.TenantEnabled ||
		resolved.TenantTokenLimit == nil || *resolved.TenantTokenLimit != limit ||
		len(resolved.ModelAliases) != 1 || resolved.ModelAliases[0].Alias != "friendly-model" {
		t.Fatalf("resolve key = %+v", resolved)
	}

	started := time.Now()
	if err := dataStore.WriteLog(ctx, LogInput{
		ID: identity.NewID(), TenantID: tenantID, APIKeyID: keyID, Model: "actual-model",
		Method: "POST", Path: "/v1/responses", StatusCode: 200,
		Usage: Usage{Prompt: 10, Completion: 5, Total: 15}, Settled: true,
		StartedAt: started, CompletedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	tenantTokens, keyTokens, err := dataStore.DailyTokens(ctx, tenantID, keyID)
	if err != nil || tenantTokens != 15 || keyTokens != 15 {
		t.Fatalf("daily tokens after insert = %d, %d, err=%v", tenantTokens, keyTokens, err)
	}

	upsertID := identity.NewID()
	if err := dataStore.UpsertLog(ctx, LogInput{
		ID: upsertID, TenantID: tenantID, APIKeyID: keyID, Model: "actual-model",
		Method: "GET", Path: "/v1/responses/ws", StatusCode: 101,
		Usage: Usage{Prompt: 2, Completion: 1, Total: 3}, Settled: true,
		StartedAt: started, CompletedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := dataStore.UpsertLog(ctx, LogInput{
		ID: upsertID, TenantID: tenantID, APIKeyID: keyID, Model: "actual-model",
		Method: "GET", Path: "/v1/responses/ws", StatusCode: 101,
		Usage: Usage{Prompt: 4, Completion: 6, Total: 10}, Settled: true,
		StartedAt: started, CompletedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	tenantTokens, keyTokens, err = dataStore.DailyTokens(ctx, tenantID, keyID)
	if err != nil || tenantTokens != 25 || keyTokens != 25 {
		t.Fatalf("daily tokens after upsert delta = %d, %d, err=%v", tenantTokens, keyTokens, err)
	}

	resolved, err = dataStore.ResolveKey(ctx, plain)
	if err != nil {
		t.Fatal(err)
	}
	gotTenant, gotKey := resolved.DailyTokenUsage(time.Now())
	if gotTenant != 25 || gotKey != 25 {
		t.Fatalf("resolve key daily usage = %d, %d", gotTenant, gotKey)
	}

	dataStore.TouchKey(ctx, keyID)
	dataStore.TouchKey(ctx, keyID)
	var key db.APIKey
	if err := database.First(&key, "id = ?", keyID).Error; err != nil {
		t.Fatal(err)
	}
	if key.LastUsedAt == nil {
		t.Fatal("first touch did not persist last_used_at")
	}
	firstTouch := *key.LastUsedAt
	time.Sleep(20 * time.Millisecond)
	dataStore.TouchKey(ctx, keyID)
	if err := database.First(&key, "id = ?", keyID).Error; err != nil {
		t.Fatal(err)
	}
	if !key.LastUsedAt.Equal(firstTouch) {
		t.Fatalf("debounced touch changed last_used_at from %v to %v", firstTouch, key.LastUsedAt)
	}
}
