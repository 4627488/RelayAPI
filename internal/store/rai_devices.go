package store

import (
	"context"
	"time"
)

// RAIDevice exposes login metadata, never the underlying key or its ciphertext.
type RAIDevice struct {
	ID         string     `json:"id"`
	DeviceName string     `json:"device_name"`
	DeviceOS   string     `json:"device_os"`
	DeviceArch string     `json:"device_arch"`
	RAIVersion string     `json:"rai_version"`
	Enabled    bool       `json:"enabled"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (s Store) ListRAIDevices(ctx context.Context, tenantID string) ([]RAIDevice, error) {
	items := make([]RAIDevice, 0)
	err := scoped(ctx, s.DB).Model(&APIKey{}).
		Select("id", "device_name", "device_os", "device_arch", "rai_version", "enabled", "expires_at", "last_used_at", "created_at").
		Where("tenant_id = ? AND source = ?", tenantID, "rai").Order("created_at DESC").Find(&items).Error
	return items, err
}

func (s Store) RevokeRAIDevice(ctx context.Context, tenantID, id string) error {
	result := scoped(ctx, s.DB).Model(&APIKey{}).
		Where("tenant_id = ? AND id = ? AND source = ?", tenantID, id, "rai").
		Updates(map[string]any{"enabled": false, "key_ciphertext": []byte(nil)})
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) ListManualKeys(ctx context.Context, tenantID string) ([]APIKey, error) {
	filtered := s
	filtered.DB = s.DB.Where("source = ?", "manual")
	return filtered.ListKeys(ctx, tenantID)
}
