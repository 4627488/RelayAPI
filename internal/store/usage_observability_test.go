package store

import (
	"context"
	"os"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestUsageObservabilityIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	// A connection-local temporary table makes this test independent of migrations
	// and avoids changing any existing request or tenant data.
	err = tx.Exec(`CREATE TEMP TABLE request_logs (
 tenant_id text, started_at timestamptz, log_unit text, latency_ms bigint,
 first_token_ms bigint, ttftms bigint, pricing_complete boolean, settled boolean,
 model text, status_code integer, error_code text, provider text,
 total_tokens bigint, cost_nano_usd bigint) ON COMMIT DROP`).Error
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, row := range []struct {
		tenant, unit string
		latency      int
		first, ttft  any
		status       int
		code         string
		at           time.Time
	}{
		{"a", "step", 100, 0, 10, 200, "", now},
		{"a", "step", 300, nil, nil, 200, "upstream_error", now},
		{"a", "legacy_session", 9999, 999, 999, 200, "", now},
		{"b", "step", 8000, 5000, 6000, 503, "other_tenant", now},
		{"a", "step", 8888, 888, 888, 500, "expired", now.Add(-48 * time.Hour)},
	} {
		if err = tx.Exec(`INSERT INTO request_logs VALUES (?, ?, ?, ?, ?, ?, true, false, 'model', ?, ?, 'provider', 10, 100)`, row.tenant, row.at, row.unit, row.latency, row.first, row.ttft, row.status, row.code).Error; err != nil {
			t.Fatal(err)
		}
	}
	store := Store{DB: tx}
	got, err := store.usageObservability(context.Background(), "a", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got.RetainedRequests != 3 || got.StepSamples != 2 || got.FirstTokenSamples != 1 || got.TTFTSamples != 1 {
		t.Fatalf("wrong sample coverage: %+v", got)
	}
	if got.LatencyP50 == nil || *got.LatencyP50 != 200 || got.LatencyP95 == nil || *got.LatencyP95 != 290 {
		t.Fatalf("wrong percentiles: %+v", got)
	}
	if got.FirstTokenP50 == nil || *got.FirstTokenP50 != 0 || got.TTFTP50 == nil || *got.TTFTP50 != 10 {
		t.Fatalf("zero or null observation lost: %+v", got)
	}
	if len(got.Failures) != 1 || got.Failures[0].ErrorCode != "upstream_error" || len(got.Providers) != 0 {
		t.Fatalf("tenant isolation failed: %+v", got)
	}
	if got.UnsettledRequests != 3 || got.UnpricedRequests != 0 {
		t.Fatalf("wrong billing state: %+v", got)
	}
	empty, err := store.usageObservability(context.Background(), "empty", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if empty.LatencyP50 != nil || empty.FirstTokenP50 != nil || empty.TTFTP50 != nil || empty.RetainedRequests != 0 {
		t.Fatalf("empty observations fabricated: %+v", empty)
	}
	global, err := store.usageObservability(context.Background(), "", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(global.Providers) != 1 || global.Providers[0].Requests != 4 || global.Providers[0].Errors != 2 {
		t.Fatalf("wrong global attribution: %+v", global)
	}
}
