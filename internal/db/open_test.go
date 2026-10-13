package db

import (
	"context"
	"os"
	"sync"
	"testing"
)

func TestOpenSerializesParallelSchemaSetup(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			database, err := Open(ctx, dsn)
			if err != nil {
				errs <- err
				return
			}
			sqlDB, err := database.DB()
			if err != nil {
				errs <- err
				return
			}
			_ = sqlDB.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestUsageIndexMigrationRemovesOnlyLegacyDuplicates(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := withSchemaLock(t.Context(), connection, func() error {
		for _, statement := range []string{
			`CREATE INDEX IF NOT EXISTS idx_request_logs_cpa_request_id ON request_logs(upstream_request_id)`,
			`CREATE INDEX IF NOT EXISTS idx_request_logs_cpa_trace_id ON request_logs(upstream_trace_id)`,
			`CREATE INDEX IF NOT EXISTS idx_request_logs_cpa_execution_id ON request_logs(upstream_execution_id)`,
			`DELETE FROM schema_migrations WHERE version = 14`,
			`DELETE FROM schema_migrations WHERE version = 15`,
		} {
			if err := database.Exec(statement).Error; err != nil {
				return err
			}
		}
		return runMigrations(t.Context(), database)
	}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"idx_request_logs_cpa_request_id", "idx_request_logs_cpa_trace_id", "idx_request_logs_cpa_execution_id", "request_logs_token_rate_idx"} {
		if database.Migrator().HasIndex(&RequestLog{}, name) {
			t.Fatalf("legacy index remains: %s", name)
		}
	}
	for _, name := range []string{"idx_request_logs_upstream_request_id", "idx_request_logs_upstream_trace_id", "idx_request_logs_upstream_execution_id", "request_logs_usage_cover_idx", "request_logs_output_token_rate_idx"} {
		if !database.Migrator().HasIndex(&RequestLog{}, name) {
			t.Fatalf("required index missing: %s", name)
		}
	}
}
