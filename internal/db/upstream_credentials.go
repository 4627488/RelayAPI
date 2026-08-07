package db

import (
	"time"

	"github.com/lib/pq"
)

// UpstreamCredential stores one provider document encrypted as a whole. The
// indexed columns are deliberately non-secret routing metadata only.
type UpstreamCredential struct {
	ID             string         `gorm:"primaryKey" json:"id"`
	Name           string         `gorm:"not null;default:''" json:"name"`
	Provider       string         `gorm:"not null;index" json:"provider"`
	Enabled        bool           `gorm:"not null;index" json:"enabled"`
	Models         pq.StringArray `gorm:"type:text[];not null;default:'{}'" json:"models"`
	SealedDocument []byte         `gorm:"type:bytea;not null" json:"-"`
	Source         string         `gorm:"not null;default:'native'" json:"source"`
	Revision       int64          `gorm:"not null;default:1" json:"revision"`
	ExpiresAt      *time.Time     `json:"expires_at"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
}
