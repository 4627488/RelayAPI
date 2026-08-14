package db

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

type SchemaMigration struct {
	Version   int       `gorm:"primaryKey"`
	Name      string    `gorm:"not null"`
	AppliedAt time.Time `gorm:"not null"`
}

type migration struct {
	version    int
	name       string
	statements []string
}

var migrations = []migration{
	{
		version: 1,
		name:    "parent and child subscriptions",
		statements: []string{
			`ALTER TABLE parent_subscriptions ADD CONSTRAINT parent_capacity_mode_check CHECK (capacity_mode IN ('unmetered','observed'))`,
			`ALTER TABLE parent_subscriptions ADD CONSTRAINT parent_allocation_limit_check CHECK (allocation_limit_ppm > 0)`,
			`ALTER TABLE parent_quota_windows ADD CONSTRAINT parent_quota_limit_check CHECK (limit_nano_usd > 0)`,
			`ALTER TABLE parent_quota_windows ADD CONSTRAINT parent_quota_parent_fk FOREIGN KEY (parent_subscription_id) REFERENCES parent_subscriptions(id) ON DELETE CASCADE`,
			`ALTER TABLE parent_quota_observations ADD CONSTRAINT parent_quota_observation_parent_fk FOREIGN KEY (parent_subscription_id) REFERENCES parent_subscriptions(id) ON DELETE CASCADE`,
			`ALTER TABLE child_subscriptions ADD CONSTRAINT child_allocation_check CHECK (allocation_ppm > 0)`,
			`ALTER TABLE child_subscriptions ADD CONSTRAINT child_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`,
			`ALTER TABLE child_subscriptions ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_subscription_id) REFERENCES parent_subscriptions(id) ON DELETE RESTRICT`,
			`ALTER TABLE child_quota_windows ADD CONSTRAINT child_quota_limit_check CHECK (limit_nano_usd > 0 AND settled_nano_usd >= 0 AND reserved_nano_usd >= 0)`,
			`ALTER TABLE child_quota_windows ADD CONSTRAINT child_quota_child_fk FOREIGN KEY (child_subscription_id) REFERENCES child_subscriptions(id) ON DELETE CASCADE`,
			`ALTER TABLE request_reservations ADD CONSTRAINT request_reservation_status_check CHECK (status IN ('active','settled','released','expired'))`,
			`ALTER TABLE request_reservations ADD CONSTRAINT request_reservation_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT`,
			`ALTER TABLE request_reservations ADD CONSTRAINT request_reservation_child_fk FOREIGN KEY (child_subscription_id) REFERENCES child_subscriptions(id) ON DELETE SET NULL`,
			`ALTER TABLE request_reservations ADD CONSTRAINT request_reservation_parent_fk FOREIGN KEY (parent_subscription_id) REFERENCES parent_subscriptions(id) ON DELETE SET NULL`,
		},
	},
	{
		version: 2,
		name:    "separate Upstream scheduler ID from auth index",
		statements: []string{
			`UPDATE parent_subscriptions SET upstream_auth_index = upstream_credential_id WHERE upstream_auth_index = ''`,
			`CREATE UNIQUE INDEX parent_subscriptions_upstream_auth_index_unique ON parent_subscriptions(upstream_auth_index)`,
		},
	},
	{
		version: 3,
		name:    "promote first user to administrator",
		statements: []string{
			`UPDATE tenants
			 SET is_admin = TRUE
			 WHERE id = (
				 SELECT id FROM tenants ORDER BY created_at ASC, id ASC LIMIT 1
			 )
			 AND NOT EXISTS (SELECT 1 FROM tenants WHERE is_admin = TRUE)`,
		},
	},
	{
		version: 4,
		name:    "fold manual windows into observed USD conversions",
		statements: []string{
			`UPDATE parent_quota_windows SET source = 'manual_conversion' WHERE source = 'manual'`,
			`UPDATE parent_subscriptions SET capacity_mode = 'observed' WHERE capacity_mode = 'manual'`,
			`ALTER TABLE parent_subscriptions DROP CONSTRAINT parent_capacity_mode_check`,
			`ALTER TABLE parent_subscriptions ADD CONSTRAINT parent_capacity_mode_check CHECK (capacity_mode IN ('unmetered','observed'))`,
			`ALTER TABLE parent_quota_windows ALTER COLUMN source SET DEFAULT 'manual_conversion'`,
		},
	},
	{
		version: 5,
		name:    "bounded retention indexes",
		statements: []string{
			`CREATE INDEX IF NOT EXISTS request_logs_cleanup_idx ON request_logs(completed_at, id)`,
			`CREATE INDEX IF NOT EXISTS request_log_details_cleanup_idx ON request_log_details(created_at, request_log_id)`,
			`CREATE INDEX IF NOT EXISTS upstream_lifecycle_cleanup_idx ON upstream_lifecycle_events(processed, created_at, id)`,
			`CREATE INDEX IF NOT EXISTS request_reservations_cleanup_idx ON request_reservations(status, pricing_complete, settled_at, request_id)`,
			`CREATE INDEX IF NOT EXISTS billing_ledgers_cleanup_idx ON billing_ledgers(created_at, id)`,
			`CREATE INDEX IF NOT EXISTS quota_observations_cleanup_idx ON parent_quota_observations(created_at, id)`,
			`CREATE INDEX IF NOT EXISTS invitations_cleanup_idx ON invitations(created_at, id)`,
		},
	},
	{
		version: 6,
		name:    "durable websocket turn accounting",
		statements: []string{
			`ALTER TABLE web_socket_turns ADD CONSTRAINT web_socket_turn_request_fk FOREIGN KEY (request_id) REFERENCES request_reservations(request_id) ON DELETE CASCADE`,
			`CREATE INDEX IF NOT EXISTS web_socket_turns_created_idx ON web_socket_turns(created_at, request_id)`,
		},
	},
	{
		version: 7,
		name:    "reusable outbound proxies",
		statements: []string{
			`ALTER TABLE upstream_credentials ADD CONSTRAINT upstream_credentials_proxy_fk FOREIGN KEY (proxy_id) REFERENCES outbound_proxies(id) ON DELETE RESTRICT`,
		},
	},
	{
		version: 8,
		name:    "native upstream naming",
		statements: []string{
			`DO $$ BEGIN
				IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parent_subscriptions' AND column_name='cpa_auth_id') THEN
					UPDATE parent_subscriptions SET
						upstream_credential_id = cpa_auth_id,
						upstream_auth_index = CASE WHEN cpa_auth_index = '' THEN cpa_auth_id ELSE cpa_auth_index END,
						upstream_credential_name = cpa_auth_name,
						upstream_unavailable = cpa_unavailable,
						upstream_model_allowlist = cpa_model_allowlist;
					ALTER TABLE parent_subscriptions
						DROP COLUMN cpa_auth_id CASCADE,
						DROP COLUMN cpa_auth_index CASCADE,
						DROP COLUMN cpa_auth_name CASCADE,
						DROP COLUMN cpa_unavailable CASCADE,
						DROP COLUMN cpa_model_allowlist CASCADE;
				END IF;
			END $$`,
			`DO $$ BEGIN
				IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_reservations' AND column_name='cpa_auth_id') THEN
					UPDATE request_reservations SET upstream_credential_id=cpa_auth_id, upstream_auth_index=cpa_auth_index;
					ALTER TABLE request_reservations DROP COLUMN cpa_auth_id CASCADE, DROP COLUMN cpa_auth_index CASCADE;
				END IF;
			END $$`,
			`DO $$ BEGIN
				IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='cpa_request_id') THEN
					UPDATE request_logs SET upstream_request_id=cpa_request_id, upstream_trace_id=cpa_trace_id, upstream_execution_id=cpa_execution_id;
					ALTER TABLE request_logs DROP COLUMN cpa_request_id CASCADE, DROP COLUMN cpa_trace_id CASCADE, DROP COLUMN cpa_execution_id CASCADE;
				END IF;
			END $$`,
			`DO $$ BEGIN
				IF to_regclass('public.cpa_lifecycle_events') IS NOT NULL THEN
					INSERT INTO upstream_lifecycle_events SELECT * FROM cpa_lifecycle_events ON CONFLICT DO NOTHING;
					DROP TABLE cpa_lifecycle_events CASCADE;
				END IF;
			END $$`,
			`DROP INDEX IF EXISTS parent_subscriptions_cpa_auth_index_unique`,
			`DROP INDEX IF EXISTS cpa_lifecycle_cleanup_idx`,
			`DO $$ BEGIN
				IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cpa_lifecycle_events_pkey')
				AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='upstream_lifecycle_events_pkey') THEN
					ALTER TABLE upstream_lifecycle_events RENAME CONSTRAINT cpa_lifecycle_events_pkey TO upstream_lifecycle_events_pkey;
				END IF;
			END $$`,
			`UPDATE schema_migrations SET name='separate upstream scheduler ID from auth index' WHERE version=2`,
			`CREATE UNIQUE INDEX IF NOT EXISTS parent_subscriptions_upstream_auth_index_unique ON parent_subscriptions(upstream_auth_index)`,
			`CREATE INDEX IF NOT EXISTS upstream_lifecycle_cleanup_idx ON upstream_lifecycle_events(processed, created_at, id)`,
		},
	},
}

// prepareNativeSchema renames legacy columns before AutoMigrate. Doing this
// first is essential: adding a new non-null credential ID column to a populated
// installation would fail before the data-copy migration could run.
func prepareNativeSchema(ctx context.Context, database *gorm.DB) error {
	statements := []string{
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parent_subscriptions' AND column_name='cpa_auth_id')
			AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parent_subscriptions' AND column_name='upstream_credential_id') THEN
				ALTER TABLE parent_subscriptions RENAME COLUMN cpa_auth_id TO upstream_credential_id;
				ALTER TABLE parent_subscriptions RENAME COLUMN cpa_auth_index TO upstream_auth_index;
				ALTER TABLE parent_subscriptions RENAME COLUMN cpa_auth_name TO upstream_credential_name;
				ALTER TABLE parent_subscriptions RENAME COLUMN cpa_unavailable TO upstream_unavailable;
				ALTER TABLE parent_subscriptions RENAME COLUMN cpa_model_allowlist TO upstream_model_allowlist;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_reservations' AND column_name='cpa_auth_id')
			AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_reservations' AND column_name='upstream_credential_id') THEN
				ALTER TABLE request_reservations RENAME COLUMN cpa_auth_id TO upstream_credential_id;
				ALTER TABLE request_reservations RENAME COLUMN cpa_auth_index TO upstream_auth_index;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='cpa_request_id')
			AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='upstream_request_id') THEN
				ALTER TABLE request_logs RENAME COLUMN cpa_request_id TO upstream_request_id;
				ALTER TABLE request_logs RENAME COLUMN cpa_trace_id TO upstream_trace_id;
				ALTER TABLE request_logs RENAME COLUMN cpa_execution_id TO upstream_execution_id;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF to_regclass('public.cpa_lifecycle_events') IS NOT NULL AND to_regclass('public.upstream_lifecycle_events') IS NULL THEN
				ALTER TABLE cpa_lifecycle_events RENAME TO upstream_lifecycle_events;
				ALTER TABLE upstream_lifecycle_events RENAME COLUMN cpa_execution_id TO upstream_execution_id;
				ALTER TABLE upstream_lifecycle_events RENAME COLUMN cpa_trace_id TO upstream_trace_id;
			END IF;
		END $$`,
	}
	for _, statement := range statements {
		if err := database.WithContext(ctx).Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}

func runMigrations(ctx context.Context, database *gorm.DB) error {
	if err := database.WithContext(ctx).AutoMigrate(&SchemaMigration{}); err != nil {
		return err
	}
	for _, item := range migrations {
		var count int64
		if err := database.WithContext(ctx).Model(&SchemaMigration{}).Where("version = ?", item.version).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			continue
		}
		if err := database.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			for _, statement := range item.statements {
				if err := tx.Exec(statement).Error; err != nil {
					return fmt.Errorf("migration %d %s: %w", item.version, item.name, err)
				}
			}
			return tx.Create(&SchemaMigration{Version: item.version, Name: item.name, AppliedAt: time.Now()}).Error
		}); err != nil {
			return err
		}
	}
	return nil
}
