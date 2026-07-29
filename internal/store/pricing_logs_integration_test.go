package store

import (
	"context"
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
	if err := database.Exec(`TRUNCATE cpa_lifecycle_events, request_log_details, request_reservations,
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
	dataStore, err := New(database)
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
	if err := dataStore.RecordCPALifecycleEvent(ctx, CPALifecycleInput{
		RequestLogID: requestID, Event: "request.intercept_after", CPAExecutionID: "cpa-execution",
		CPATraceID: "cpa-trace", Model: "actual-model", RequestedModel: "alias-model",
		Provider: "openai", ExecutorType: "codex", AuthIndex: "auth-priority",
		Headers: `{"X-Test":["value"]}`, Body: `{"model":"actual-model"}`,
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
		Detail: &LogDetailInput{RequestHeaders: `{}`, RequestBody: `{}`, ForwardedHeaders: `{}`,
			ForwardedBody: `{}`, UpstreamHeaders: `{}`, UpstreamBody: `{}`, StageTimings: `{}`},
	}); err != nil {
		t.Fatal(err)
	}
	detailed, err := dataStore.RequestLogDetail(ctx, requestID, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if detailed.Log.CPAExecutionID != "cpa-execution" || detailed.Log.ActualModel != "actual-model" ||
		detailed.Detail == nil || detailed.Detail.ForwardedBody != `{"model":"actual-model"}` {
		t.Fatalf("lifecycle enrichment missing: %+v / %+v", detailed.Log, detailed.Detail)
	}
	page, err := dataStore.QueryLogs(ctx, LogQuery{TenantID: tenantID, Query: "cpa-trace", PageSize: 25})
	if err != nil || page.Total != 1 || page.Summary.Tokens != 12 {
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
}
