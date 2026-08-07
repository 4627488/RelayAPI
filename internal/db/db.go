package db

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

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
	// needless reconnect churn under the same concurrency accepted by CPA.
	sqlDB.SetMaxOpenConns(32)
	sqlDB.SetMaxIdleConns(16)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if err := database.WithContext(ctx).AutoMigrate(
		&Tenant{}, &APIKey{}, &APIKeyModelAlias{}, &ModelPrice{}, &ModelCatalogPrice{}, &ModelAlias{}, &ModelPriceRule{},
		&BillingLedger{}, &UsageDailyRollup{}, &RequestLog{}, &RequestLogDetail{}, &CPALifecycleEvent{}, &Invitation{}, &AgentSetup{},
		&ParentSubscription{}, &ParentQuotaWindow{}, &ParentQuotaObservation{},
		&ChildSubscription{}, &ChildQuotaWindow{}, &RequestReservation{},
		&UpstreamCredential{},
	); err != nil {
		return nil, fmt.Errorf("gorm automigrate: %w", err)
	}
	if err := runMigrations(ctx, database); err != nil {
		return nil, fmt.Errorf("schema migrations: %w", err)
	}
	return database, nil
}
