package db

import (
	"encoding/json"
	"time"

	"github.com/lib/pq"
)

const (
	ParentCapacityUnmetered           = "unmetered"
	ParentCapacityObserved            = "observed"
	ParentQuotaSourceManualConversion = "manual_conversion"

	ReservationActive   = "active"
	ReservationSettled  = "settled"
	ReservationReleased = "released"
	ReservationExpired  = "expired"
)

// ParentSubscription is a redacted accounting mirror of one stable upstream credential.
// Provider secrets and OAuth material remain encrypted in Relay's credential store.
// AllocationLimitPPM is retained as a fixed 100% schema-compatibility baseline;
// child allocations may exceed it and the UI reports that state as a warning.
type ParentSubscription struct {
	ID                     string          `gorm:"type:uuid;primaryKey" json:"id"`
	UpstreamCredentialID   string          `gorm:"not null;uniqueIndex" json:"upstream_credential_id"`
	UpstreamAuthIndex      string          `gorm:"not null;default:'';index" json:"upstream_auth_index"`
	UpstreamCredentialName string          `gorm:"not null;default:'';index" json:"upstream_credential_name"`
	Name                   string          `gorm:"not null" json:"name"`
	Provider               string          `gorm:"not null;default:'';index" json:"provider"`
	PlanType               string          `gorm:"not null;default:''" json:"plan_type"`
	Status                 string          `gorm:"not null;default:'unknown'" json:"status"`
	UpstreamUnavailable    bool            `gorm:"not null;default:false;index" json:"upstream_unavailable"`
	CapacityMode           string          `gorm:"not null;default:'unmetered'" json:"capacity_mode"`
	AllocationLimitPPM     int64           `gorm:"not null;default:1000000" json:"allocation_limit_ppm"`
	Enabled                bool            `gorm:"not null;index" json:"enabled"`
	UpstreamModelAllowlist pq.StringArray  `gorm:"type:text[];not null;default:'{}'" json:"upstream_model_allowlist"`
	ModelAllowlist         pq.StringArray  `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	Metadata               json.RawMessage `gorm:"type:jsonb;not null;default:'{}'" json:"metadata"`
	LastSyncedAt           *time.Time      `json:"last_synced_at"`
	QuotaSupported         bool            `gorm:"not null;default:false" json:"quota_supported"`
	QuotaProbeStatus       string          `gorm:"not null;default:'unknown'" json:"quota_probe_status"`
	QuotaProbeError        string          `gorm:"not null;default:''" json:"quota_probe_error"`
	QuotaObservedAt        *time.Time      `json:"quota_observed_at"`
	QuotaSnapshot          json.RawMessage `gorm:"type:jsonb;not null;default:'{}'" json:"quota_snapshot"`
	CreatedAt              time.Time       `json:"created_at"`
	UpdatedAt              time.Time       `json:"updated_at"`
}

type ParentQuotaWindow struct {
	ParentSubscriptionID string     `gorm:"type:uuid;primaryKey" json:"parent_subscription_id"`
	Kind                 string     `gorm:"primaryKey" json:"kind"`
	LimitNanoUSD         int64      `gorm:"not null" json:"limit_nano_usd"`
	ResetsAt             time.Time  `gorm:"not null;index" json:"resets_at"`
	Source               string     `gorm:"not null;default:'manual_conversion'" json:"source"`
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
	UpstreamCredentialID   string          `gorm:"not null;default:'';index" json:"upstream_credential_id"`
	UpstreamAuthIndex      string          `gorm:"not null;default:'';index" json:"upstream_auth_index"`
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

// WebSocketTurn makes terminal Responses events durable before the enclosing
// WebSocket session ends. RequestID + TurnID is the idempotency key used when a
// terminal frame is replayed by either side of the relay.
type WebSocketTurn struct {
	RequestID              string    `gorm:"type:uuid;primaryKey" json:"request_id"`
	TurnID                 string    `gorm:"primaryKey" json:"turn_id"`
	Model                  string    `gorm:"not null;default:''" json:"model"`
	PromptTokens           int64     `gorm:"not null;default:0" json:"prompt_tokens"`
	CompletionTokens       int64     `gorm:"not null;default:0" json:"completion_tokens"`
	CachedTokens           int64     `gorm:"not null;default:0" json:"cached_tokens"`
	CacheWriteTokens       int64     `gorm:"not null;default:0" json:"cache_write_tokens"`
	ReasoningTokens        int64     `gorm:"not null;default:0" json:"reasoning_tokens"`
	ImageInputTokens       int64     `gorm:"not null;default:0" json:"image_input_tokens"`
	CachedImageInputTokens int64     `gorm:"not null;default:0" json:"cached_image_input_tokens"`
	ImageOutputTokens      int64     `gorm:"not null;default:0" json:"image_output_tokens"`
	TotalTokens            int64     `gorm:"not null;default:0" json:"total_tokens"`
	CostNanoUSD            int64     `gorm:"not null;default:0" json:"cost_nano_usd"`
	PricingComplete        bool      `gorm:"not null;default:false" json:"pricing_complete"`
	RequestBodyBytes       int64     `gorm:"not null;default:0" json:"request_body_bytes"`
	ResponseBodyBytes      int64     `gorm:"not null;default:0" json:"response_body_bytes"`
	LatencyMS              int64     `gorm:"not null;default:0" json:"latency_ms"`
	StartedAt              time.Time `json:"started_at"`
	CompletedAt            time.Time `json:"completed_at"`
	CreatedAt              time.Time `gorm:"not null" json:"created_at"`
}
