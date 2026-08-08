package db

import "time"

// RuntimeSetting stores encrypted administrator-controlled runtime configuration.
// A single named record is used today, while the key keeps the schema extensible.
type RuntimeSetting struct {
	Key            string    `gorm:"primaryKey"`
	SealedDocument []byte    `gorm:"type:bytea;not null"`
	UpdatedAt      time.Time `json:"updated_at"`
}
