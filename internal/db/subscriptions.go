package db

import (
	"encoding/json"
	"time"

	"github.com/lib/pq"
)

const (
	ParentCapacityUnmetered = "unmetered"
	ParentCapacityManual    = "manual"
	ParentCapacityObserved  = "observed"

	ReservationActive   = "active"
	ReservationSettled  = "settled"
	ReservationReleased = "released"
	ReservationExpired  = "expired"
)

// ParentSubscription is a redacted accounting mirror of one stable CPA AuthID.
// Provider secrets and OAuth material remain exclusively inside CLIProxyAPI.
type ParentSubscription struct {
	ID                 string          `gorm:"type:uuid;primaryKey" json:"id"`
	CPAAuthID          string          `gorm:"not null;uniqueIndex" json:"cpa_auth_id"`
	CPAAuthName        string          `gorm:"not null;default:'';index" json:"cpa_auth_name"`
	Name               string          `gorm:"not null" json:"name"`
	Provider           string          `gorm:"not null;default:'';index" json:"provider"`
	PlanType           string          `gorm:"not null;default:''" json:"plan_type"`
	Status             string          `gorm:"not null;default:'unknown'" json:"status"`
	CPAUnavailable     bool            `gorm:"not null;default:false;index" json:"cpa_unavailable"`
	CapacityMode       string          `gorm:"not null;default:'unmetered'" json:"capacity_mode"`
	AllocationLimitPPM int64           `gorm:"not null;default:1000000" json:"allocation_limit_ppm"`
	Enabled            bool            `gorm:"not null;index" json:"enabled"`
	CPAModelAllowlist  pq.StringArray  `gorm:"type:text[];not null;default:'{}'" json:"cpa_model_allowlist"`
	ModelAllowlist     pq.StringArray  `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	Metadata           json.RawMessage `gorm:"type:jsonb;not null;default:'{}'" json:"metadata"`
	LastSyncedAt       *time.Time      `json:"last_synced_at"`
	CreatedAt          time.Time       `json:"created_at"`
	UpdatedAt          time.Time       `json:"updated_at"`
}

type ParentQuotaWindow struct {
	ParentSubscriptionID string     `gorm:"type:uuid;primaryKey" json:"parent_subscription_id"`
	Kind                 string     `gorm:"primaryKey" json:"kind"`
	LimitNanoUSD         int64      `gorm:"not null" json:"limit_nano_usd"`
	ResetsAt             time.Time  `gorm:"not null;index" json:"resets_at"`
	Source               string     `gorm:"not null;default:'manual'" json:"source"`
	ObservedUsedPercent  *float64   `json:"observed_used_percent"`
	ObservedAt           *time.Time `json:"observed_at"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

type ParentQuotaObservation struct {
	ID                   string    `gorm:"type:uuid;primaryKey" json:"id"`
	ParentSubscriptionID string    `gorm:"type:uuid;not null;index:parent_quota_observations_idx,priority:1" json:"parent_subscription_id"`
	Kind                 string    `gorm:"not null;index:parent_quota_observations_idx,priority:2" json:"kind"`
	UsedPercent          float64   `gorm:"not null" json:"used_percent"`
	ResetsAt             time.Time `gorm:"not null" json:"resets_at"`
	ObservedAt           time.Time `gorm:"not null;index:parent_quota_observations_idx,priority:3,sort:desc" json:"observed_at"`
	CostSincePrevious    int64     `gorm:"not null;default:0" json:"cost_since_previous_nano_usd"`
	EstimatedLimit       *int64    `json:"estimated_limit_nano_usd"`
	Accepted             bool      `gorm:"not null;default:false" json:"accepted"`
	Reason               string    `gorm:"not null;default:''" json:"reason"`
	CreatedAt            time.Time `json:"created_at"`
}

type ChildSubscription struct {
	ID                   string         `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID             string         `gorm:"type:uuid;not null;index:child_subscriptions_tenant_idx,priority:1" json:"tenant_id"`
	ParentSubscriptionID string         `gorm:"type:uuid;not null;index:child_subscriptions_parent_idx,priority:1" json:"parent_subscription_id"`
	Name                 string         `gorm:"not null" json:"name"`
	AllocationPPM        int64          `gorm:"not null" json:"allocation_ppm"`
	Priority             int            `gorm:"not null;default:100" json:"priority"`
	Enabled              bool           `gorm:"not null;index" json:"enabled"`
	ModelAllowlist       pq.StringArray `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	StartsAt             time.Time      `gorm:"not null" json:"starts_at"`
	ExpiresAt            *time.Time     `json:"expires_at"`
	CreatedAt            time.Time      `json:"created_at"`
	UpdatedAt            time.Time      `json:"updated_at"`
}

type ChildQuotaWindow struct {
	ChildSubscriptionID string    `gorm:"type:uuid;primaryKey" json:"child_subscription_id"`
	Kind                string    `gorm:"primaryKey" json:"kind"`
	StartedAt           time.Time `gorm:"not null" json:"started_at"`
	ResetsAt            time.Time `gorm:"not null;index" json:"resets_at"`
	LimitNanoUSD        int64     `gorm:"not null" json:"limit_nano_usd"`
	SettledNanoUSD      int64     `gorm:"not null;default:0" json:"settled_nano_usd"`
	ReservedNanoUSD     int64     `gorm:"not null;default:0" json:"reserved_nano_usd"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// RequestReservation is the idempotency authority for both customer balance
// and child-subscription capacity accounting.
type RequestReservation struct {
	RequestID              string          `gorm:"type:uuid;primaryKey" json:"request_id"`
	TenantID               string          `gorm:"type:uuid;not null;index" json:"tenant_id"`
	APIKeyID               string          `gorm:"type:uuid;not null;index" json:"api_key_id"`
	ChildSubscriptionID    *string         `gorm:"type:uuid;index" json:"child_subscription_id"`
	ParentSubscriptionID   *string         `gorm:"type:uuid;index" json:"parent_subscription_id"`
	CPAAuthID              string          `gorm:"not null;default:'';index" json:"cpa_auth_id"`
	Model                  string          `gorm:"not null;default:''" json:"model"`
	BalanceReservedNanoUSD int64           `gorm:"not null;default:0" json:"balance_reserved_nano_usd"`
	QuotaReservedNanoUSD   int64           `gorm:"not null;default:0" json:"quota_reserved_nano_usd"`
	ActualNanoUSD          *int64          `json:"actual_nano_usd"`
	PricingComplete        bool            `gorm:"not null;default:false" json:"pricing_complete"`
	PriceSnapshot          json.RawMessage `gorm:"type:jsonb;not null;default:'{}'" json:"price_snapshot"`
	QuotaWindows           json.RawMessage `gorm:"type:jsonb;not null;default:'[]'" json:"quota_windows"`
	Status                 string          `gorm:"not null;default:'active';index" json:"status"`
	ExpiresAt              time.Time       `gorm:"not null;index" json:"expires_at"`
	CreatedAt              time.Time       `json:"created_at"`
	SettledAt              *time.Time      `json:"settled_at"`
}
