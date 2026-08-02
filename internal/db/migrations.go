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
		name:    "separate CPA scheduler ID from auth index",
		statements: []string{
			`UPDATE parent_subscriptions SET cpa_auth_index = cpa_auth_id WHERE cpa_auth_index = ''`,
			`CREATE UNIQUE INDEX parent_subscriptions_cpa_auth_index_unique ON parent_subscriptions(cpa_auth_index)`,
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
