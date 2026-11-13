package db

import "time"

// CompactionRoute retains only a digest of an opaque upstream compaction seal.
// It survives restarts without keeping conversation text or encrypted contents.
type CompactionRoute struct {
	TenantID             string    `gorm:"type:uuid;primaryKey"`
	SealHash             string    `gorm:"size:64;primaryKey"`
	UpstreamCredentialID string    `gorm:"not null"`
	ExpiresAt            time.Time `gorm:"not null;index"`
}
