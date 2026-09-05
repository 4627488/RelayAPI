package db

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// schemaAdvisoryLockKey serializes AutoMigrate across processes that share one
// database. The value is arbitrary and stable.
const schemaAdvisoryLockKey int64 = 742184201

func Open(ctx context.Context, databaseURL string) (*gorm.DB, error) {
	databaseLogger := logger.New(log.New(os.Stderr, "", log.LstdFlags), logger.Config{
		SlowThreshold:             time.Second,
		LogLevel:                  logger.Warn,
		IgnoreRecordNotFoundError: true,
		Colorful:                  false,
	})
	database, err := gorm.Open(postgres.Open(databaseURL), &gorm.Config{
		Logger: databaseLogger,
	})
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		return nil, fmt.Errorf("postgres handle: %w", err)
	}
	// Keep enough warm local connections for the inference admission path.
	// database/sql otherwise retains only two idle connections, which causes
	// needless reconnect churn under the same concurrency accepted by Upstream.
	sqlDB.SetMaxOpenConns(32)
	sqlDB.SetMaxIdleConns(16)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	// go test ./... runs packages in parallel. CI shares one Postgres, and
	// concurrent AutoMigrate / CREATE INDEX IF NOT EXISTS races on
	// pg_type / pg_class unique indexes. Hold a session advisory lock on a
	// dedicated connection so only one Open() migrates at a time.
	if err := withSchemaLock(ctx, sqlDB, func() error {
		if err := prepareNativeSchema(ctx, database); err != nil {
			return fmt.Errorf("prepare native schema: %w", err)
		}
		if err := database.WithContext(ctx).AutoMigrate(
			&Tenant{}, &APIKey{}, &APIKeyModelAlias{}, &ModelPrice{}, &ModelCatalogPrice{}, &ModelSetting{}, &ModelAlias{}, &ModelPriceRule{},
			&BillingLedger{}, &UsageDailyRollup{}, &RequestLog{}, &RequestLogDetail{}, &UpstreamLifecycleEvent{}, &Invitation{}, &AgentSetup{}, &RAIAuthorization{},
			&ParentSubscription{}, &ParentQuotaWindow{}, &ParentQuotaObservation{},
			&ChildSubscription{}, &ChildQuotaWindow{}, &RequestReservation{}, &WebSocketTurn{},
			&OutboundProxy{}, &UpstreamCredential{}, &RuntimeSetting{},
		); err != nil {
			return fmt.Errorf("gorm automigrate: %w", err)
		}
		if err := runMigrations(ctx, database); err != nil {
			return fmt.Errorf("schema migrations: %w", err)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return database, nil
}

func withSchemaLock(ctx context.Context, sqlDB *sql.DB, fn func() error) error {
	conn, err := sqlDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("schema lock connection: %w", err)
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", schemaAdvisoryLockKey); err != nil {
		return fmt.Errorf("lock schema: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock($1)", schemaAdvisoryLockKey)
	}()
	return fn()
}
