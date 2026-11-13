package store

import (
	"context"
	"errors"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"gorm.io/gorm/clause"
)

var ErrCompactionContext = errors.New("compaction context is unknown, expired or belongs to another account")
var ErrCompactionAccount = errors.New("the account that sealed this compaction is no longer available to this tenant")

const compactionRouteLifetime = 90 * 24 * time.Hour

func (s Store) RememberCompactionRoute(ctx context.Context, tenantID, credentialID string, hashes []string) error {
	if len(hashes) == 0 || credentialID == "" {
		return nil
	}
	expires := time.Now().Add(compactionRouteLifetime)
	rows := make([]db.CompactionRoute, 0, len(hashes))
	for _, hash := range hashes {
		rows = append(rows, db.CompactionRoute{TenantID: tenantID, SealHash: hash, UpstreamCredentialID: credentialID, ExpiresAt: expires})
	}
	// A seal never changes its writer. Repeated terminal events only renew its TTL.
	return scoped(ctx, s.DB).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant_id"}, {Name: "seal_hash"}}, DoUpdates: clause.AssignmentColumns([]string{"expires_at"})}).Create(&rows).Error
}

func (s Store) CompactionCredential(ctx context.Context, tenantID string, hashes []string) (string, error) {
	if len(hashes) == 0 {
		return "", nil
	}
	var rows []db.CompactionRoute
	if err := scoped(ctx, s.DB).Where("tenant_id = ? AND seal_hash IN ? AND expires_at > ?", tenantID, hashes, time.Now()).Find(&rows).Error; err != nil {
		return "", err
	}
	if len(rows) != len(hashes) {
		return "", ErrCompactionContext
	}
	credential := rows[0].UpstreamCredentialID
	for _, row := range rows {
		if row.UpstreamCredentialID != credential {
			return "", ErrCompactionContext
		}
	}
	if err := scoped(ctx, s.DB).Model(&db.CompactionRoute{}).Where("tenant_id = ? AND seal_hash IN ?", tenantID, hashes).Update("expires_at", time.Now().Add(compactionRouteLifetime)).Error; err != nil {
		return "", err
	}
	return credential, nil
}
