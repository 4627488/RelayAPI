package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
)

func TestPricingAndDetailedLogLifecycleIntegration(t *testing.T) {
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
	if err := database.Exec(`TRUNCATE upstream_lifecycle_events, request_log_details, request_reservations,
		child_quota_windows, child_subscriptions, parent_quota_observations, parent_quota_windows,
		parent_subscriptions, billing_ledgers, request_logs, model_price_rules, model_aliases,
		model_catalog_prices, model_prices, api_keys, invitations, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	tenantID, keyID := identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{
		ID: tenantID, Name: "Pricing User", OwnerEmail: "pricing@example.test",
		PasswordHash: "test", Enabled: true, BalanceNanoUSD: 1_000_000,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{
		ID: keyID, TenantID: tenantID, Name: "Integration Key",
		KeyHash: []byte("pricing-log-integration-key"), Prefix: "relay_int", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	dataStore, err := New(database, "integration-test-api-key-encryption-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.Price(ctx, "gpt-5.6-terra"); err != nil {
		t.Fatalf("bundled fallback did not resolve: %v", err)
	}
	if err := dataStore.UpsertPrice(ctx, Price{
		Model: "admin-model", InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 4,
		ReasoningNanoUSDPerToken: 30, PriceMultiplier: 2,
	}); err != nil {
		t.Fatal(err)
	}
	if err := dataStore.ReplaceModelAliases(ctx, []db.ModelAlias{{Alias: "alias-model", Model: "admin-model"}}); err != nil {
		t.Fatal(err)
	}
	if err := dataStore.ReplacePriceRules(ctx, []db.ModelPriceRule{{
		Model: "admin-model", Field: "auth_index", Value: "auth-priority", Multiplier: 1.5,
	}}); err != nil {
		t.Fatal(err)
	}
	resolved, err := dataStore.ResolvePrice(ctx, pricing.Dimensions{Model: "alias-model", AuthIndex: "auth-priority"})
	if err != nil || resolved.InputNanoUSDPerToken != 30 || resolved.Source != pricing.SourceAdmin {
		t.Fatalf("resolved price = %+v, err=%v", resolved, err)
	}

	requestID := identity.NewID()
	if err := dataStore.RecordUpstreamLifecycleEvent(ctx, UpstreamLifecycleInput{
		RequestLogID: requestID, Event: "request.complete", UpstreamExecutionID: "upstream-execution",
		UpstreamTraceID: "upstream-trace", Model: "actual-model", RequestedModel: "alias-model",
		Provider: "openai", ExecutorType: "codex", AuthIndex: "auth-priority",
		Outcome: "succeeded",
	}); err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-time.Second)
	cost := int64(42)
	if err := dataStore.WriteLog(ctx, LogInput{
		ID: requestID, TenantID: tenantID, APIKeyID: keyID, Model: "alias-model",
		RequestedModel: "alias-model", Method: "POST", Path: "/v1/responses", RequestType: "responses",
		StatusCode: 200, Usage: Usage{Prompt: 10, Completion: 2, Total: 12},
		CostNanoUSD: &cost, Price: &resolved, PricingComplete: true, Settled: true,
		StartedAt: started, CompletedAt: time.Now(), LatencyMS: 1000,
		RequestBodyBytes: 128, ForwardedBodyBytes: 144, ResponseBodyBytes: 512,
		Detail: &LogDetailInput{RequestHeaders: `{}`, RequestBody: `{}`, ForwardedHeaders: `{}`,
			ForwardedBody: `{}`, UpstreamHeaders: `{}`, UpstreamBody: `{}`, StageTimings: `{}`},
	}); err != nil {
		t.Fatal(err)
	}
	detailed, err := dataStore.RequestLogDetail(ctx, requestID, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if detailed.Log.UpstreamExecutionID != "upstream-execution" || detailed.Log.ActualModel != "actual-model" || detailed.Detail == nil {
		t.Fatalf("lifecycle enrichment missing: %+v / %+v", detailed.Log, detailed.Detail)
	}
	if detailed.Log.RequestBodyBytes != 128 || detailed.Log.ForwardedBodyBytes != 144 || detailed.Log.ResponseBodyBytes != 512 {
		t.Fatalf("payload sizes were not persisted in the request summary: %+v", detailed.Log)
	}
	var lifecycleCount int64
	if err := database.Model(&db.UpstreamLifecycleEvent{}).Where("request_log_id = ?", requestID).Count(&lifecycleCount).Error; err != nil || lifecycleCount != 0 {
		t.Fatalf("temporary lifecycle rows = %d, err=%v", lifecycleCount, err)
	}
	if detailed.Log.ParentSubscriptionID != nil || detailed.Log.ChildSubscriptionID != nil {
		t.Fatalf("empty subscription IDs must be stored as NULL: %+v", detailed.Log)
	}
	page, err := dataStore.QueryLogs(ctx, LogQuery{TenantID: tenantID, Query: "upstream-trace", PageSize: 25})
	if err != nil || page.Total != 1 || page.Summary.Tokens != 12 || page.Summary.RequestBytes != 128 || page.Summary.ResponseBytes != 512 {
		t.Fatalf("log query = %+v, err=%v", page, err)
	}

	pendingID := identity.NewID()
	if err := dataStore.WriteLog(ctx, LogInput{
		ID: pendingID, TenantID: tenantID, APIKeyID: keyID, Model: "pending-model",
		RequestedModel: "pending-model", Method: "POST", Path: "/v1/responses",
		StatusCode: 200, Usage: Usage{Prompt: 2, Completion: 1, Total: 3},
		Settled: true, StartedAt: started, CompletedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := dataStore.UpsertPrice(ctx, Price{
		Model: "pending-model", InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 1, CacheWriteNanoUSDPerToken: 10,
		ReasoningNanoUSDPerToken: 20, PriceMultiplier: 1,
	}); err != nil {
		t.Fatal(err)
	}
	var backfilled db.RequestLog
	if err := database.First(&backfilled, "id = ?", pendingID).Error; err != nil {
		t.Fatal(err)
	}
	if !backfilled.PricingComplete || backfilled.CostNanoUSD == nil || *backfilled.CostNanoUSD != 40 {
		t.Fatalf("pending price was not backfilled: %+v", backfilled)
	}
	report, err := dataStore.UsageReport(ctx, tenantID, 30)
	if err != nil {
		t.Fatal(err)
	}
	rawKeyUsage, err := json.Marshal(report["api_keys"])
	if err != nil {
		t.Fatal(err)
	}
	var keyUsage []struct {
		APIKeyID     string `json:"api_key_id"`
		APIKeyName   string `json:"api_key_name"`
		APIKeyPrefix string `json:"api_key_prefix"`
		TenantName   string `json:"tenant_name,omitempty"`
		Requests     int64  `json:"requests"`
		Errors       int64  `json:"errors"`
		Tokens       int64  `json:"tokens"`
		Cost         int64  `json:"cost_nano_usd"`
	}
	if err := json.Unmarshal(rawKeyUsage, &keyUsage); err != nil {
		t.Fatal(err)
	}
	if len(keyUsage) != 1 || keyUsage[0].APIKeyID != keyID || keyUsage[0].Requests != 2 || keyUsage[0].Tokens != 15 {
		t.Fatalf("API key usage = %#v", report["api_keys"])
	}
	history, err := dataStore.HistoricalModelPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 {
		t.Fatalf("historical model prices = %+v", history)
	}
	historyByModel := make(map[string]HistoricalModelPrice, len(history))
	for _, item := range history {
		historyByModel[item.Model] = item
	}
	if item := historyByModel["alias-model"]; !item.Priced || item.PricedModel != "admin-model" ||
		item.InputNanoUSDPerToken != 20 || item.RequestCount != 1 {
		t.Fatalf("alias historical price = %+v", item)
	}
	if item := historyByModel["pending-model"]; !item.Priced ||
		item.InputNanoUSDPerToken != 10 || item.RequestCount != 1 {
		t.Fatalf("pending historical price = %+v", item)
	}

	for _, item := range []struct {
		id, errorCode string
	}{
		{id: identity.NewID()},
		{id: identity.NewID(), errorCode: "websocket_session_error"},
	} {
		if err := dataStore.WriteLog(ctx, LogInput{
			ID: item.id, TenantID: tenantID, APIKeyID: keyID, Model: "ws-model",
			Method: "GET", Path: "/v1/responses/ws", RequestType: "responses.websocket",
			StatusCode: 101, Stream: true, ErrorCode: item.errorCode,
			Settled: true, StartedAt: started, CompletedAt: time.Now(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	successPage, err := dataStore.QueryLogs(ctx, LogQuery{TenantID: tenantID, Model: "ws-model", Status: "success"})
	if err != nil || successPage.Total != 1 || successPage.Summary.Errors != 0 {
		t.Fatalf("successful websocket logs = %+v, err=%v", successPage, err)
	}
	errorPage, err := dataStore.QueryLogs(ctx, LogQuery{TenantID: tenantID, Model: "ws-model", Status: "error"})
	if err != nil || errorPage.Total != 1 || errorPage.Summary.Errors != 1 {
		t.Fatalf("failed websocket logs = %+v, err=%v", errorPage, err)
	}
}

func TestRetentionDeletesSuccessfulUnpricedDetails(t *testing.T) {
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
	if err := database.Exec(`TRUNCATE upstream_lifecycle_events, request_log_details, request_reservations,
		child_quota_windows, child_subscriptions, parent_quota_observations, parent_quota_windows,
		parent_subscriptions, billing_ledgers, request_logs, api_keys, tenants CASCADE`).Error; err != nil {
		t.Fatal(err)
	}

	tenantID, keyID := identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{ID: tenantID, Name: "retention", OwnerEmail: "retention@example.test",
		PasswordHash: "test", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{ID: keyID, TenantID: tenantID, Name: "retention",
		KeyHash: []byte("retention-test-key"), Prefix: "relay_ret", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	dataStore := Store{DB: database}
	completed := time.Now().Add(-48 * time.Hour)
	for _, item := range []struct {
		id, errorCode string
		status        int
	}{
		{id: identity.NewID(), status: 200},
		{id: identity.NewID(), status: 502, errorCode: "upstream_http_error"},
	} {
		if err := dataStore.WriteLog(ctx, LogInput{ID: item.id, TenantID: tenantID, APIKeyID: keyID,
			Method: "GET", Path: "/v1/models", RequestType: "v1/models", StatusCode: item.status,
			PricingComplete: false, Settled: true, ErrorCode: item.errorCode, StartedAt: completed, CompletedAt: completed,
			Detail: &LogDetailInput{RequestHeaders: `{}`, UpstreamHeaders: `{}`, UpstreamBody: `{"data":[]}`,
				StageTimings: `{}`}}); err != nil {
			t.Fatal(err)
		}
	}

	stats, err := dataStore.RunRetention(ctx, time.Now(), RetentionPolicy{
		SuccessDetailDays: 1, ErrorDetailDays: 14, BatchSize: 100, MaxRuntime: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Details != 1 {
		t.Fatalf("deleted details = %d, want 1", stats.Details)
	}
	var remaining int64
	if err := database.Model(&db.RequestLogDetail{}).Count(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("remaining details = %d, want only the error detail", remaining)
	}
}

func TestPostgresStringArrayPreservesEmptyArray(t *testing.T) {
	value, err := postgresStringArray(nil).Value()
	if err != nil {
		t.Fatal(err)
	}
	if value != "{}" {
		t.Fatalf("empty PostgreSQL array = %#v, want %q", value, "{}")
	}
	value, err = postgresStringArray([]string{"grok-4.5"}).Value()
	if err != nil {
		t.Fatal(err)
	}
	if value != `{"grok-4.5"}` {
		t.Fatalf("PostgreSQL array = %#v, want %q", value, `{"grok-4.5"}`)
	}
}
