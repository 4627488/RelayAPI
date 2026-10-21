package store

import (
	"context"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

// RAIDevice exposes login metadata, never the underlying key or its ciphertext.
type RAIDevice struct {
	Purpose    string     `json:"purpose"`
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
	now := time.Now()
	err := scoped(ctx, s.DB).Model(&APIKey{}).
		Select("id", "device_name", "device_os", "device_arch", "rai_version", "enabled", "expires_at", "last_used_at", "created_at").
		Where("tenant_id = ? AND source = ? AND enabled = ? AND (expires_at IS NULL OR expires_at > ?)", tenantID, "rai", true, now).Order("created_at DESC").Find(&items).Error
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i].Purpose = "inference"
	}
	var sessions []db.RAIOAuthSession
	if err := scoped(ctx, s.DB).Where("tenant_id = ? AND purpose = ? AND expires_at > ?", tenantID, "account", now).Order("created_at DESC").Find(&sessions).Error; err != nil {
		return nil, err
	}
	for _, session := range sessions {
		expires := session.ExpiresAt
		items = append(items, RAIDevice{ID: session.ID, Purpose: "account", DeviceName: session.DeviceName,
			DeviceOS: session.DeviceOS, DeviceArch: session.DeviceArch, RAIVersion: session.RAIVersion,
			Enabled: true, CreatedAt: session.CreatedAt, ExpiresAt: &expires})
	}
	return items, nil
}

func (s Store) RevokeRAIDevice(ctx context.Context, tenantID, id string) error {
	result := scoped(ctx, s.DB).Model(&APIKey{}).
		Where("tenant_id = ? AND id = ? AND source = ?", tenantID, id, "rai").
		Updates(map[string]any{"enabled": false, "key_ciphertext": []byte(nil)})
	if result.Error == nil && result.RowsAffected == 0 {
		return s.RevokeRAIOAuthSession(ctx, tenantID, id)
	}
	return result.Error
}

// Keep device credentials separate from manual Key CRUD.
func (s Store) IsManualKey(ctx context.Context, tenantID, id string) error {
	var key APIKey
	err := scoped(ctx, s.DB).Select("id").Where("tenant_id = ? AND id = ? AND source = ?", tenantID, id, "manual").First(&key).Error
	return notFound(err)
}

func (s Store) ListManualKeys(ctx context.Context, tenantID string) ([]APIKey, error) {
	filtered := s
	filtered.DB = s.DB.Where("source = ?", "manual")
	return filtered.ListKeys(ctx, tenantID)
}
