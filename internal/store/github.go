package store

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// Linking never matches by email or mutable GitHub login name.
func (s Store) BindGitHub(ctx context.Context, tenantID string, version, githubID int64, login string) error {
	if githubID <= 0 {
		return errors.New("invalid GitHub identity")
	}
	result := scoped(ctx, s.DB).Model(&Tenant{}).
		Where("id = ? AND password_version = ? AND enabled = true AND must_change_password = false AND github_id IS NULL AND (expires_at IS NULL OR expires_at > ?)", tenantID, version, time.Now()).
		Updates(map[string]any{"github_id": githubID, "github_login": login, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrNotFound
	}
	return nil
}

func (s Store) GitHubTenant(ctx context.Context, githubID int64) (Tenant, error) {
	var tenant Tenant
	err := scoped(ctx, s.DB).Where("github_id = ? AND enabled = true AND (expires_at IS NULL OR expires_at > ?)", githubID, time.Now()).First(&tenant).Error
	return tenant, err
}

func (s Store) UnbindGitHub(ctx context.Context, tenantID string, version int64) error {
	result := scoped(ctx, s.DB).Model(&Tenant{}).Where("id = ? AND password_version = ?", tenantID, version).
		Updates(map[string]any{"github_id": nil, "github_login": "", "password_version": gorm.Expr("password_version + 1"), "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrNotFound
	}
	return nil
}
