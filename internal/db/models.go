package db

import (
	"time"

	"github.com/lib/pq"
)

type Tenant struct {
	ID                 string         `gorm:"type:uuid;primaryKey" json:"id"`
	Name               string         `gorm:"not null" json:"name"`
	OwnerEmail         string         `gorm:"uniqueIndex;not null" json:"owner_email"`
	PasswordHash       string         `gorm:"not null" json:"-"`
	Enabled            bool           `gorm:"not null;default:true" json:"enabled"`
	BalanceNanoUSD     int64          `gorm:"not null;default:0" json:"balance_nano_usd"`
	RateLimitPerMinute *int           `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64         `json:"token_limit_daily"`
	ModelAllowlist     pq.StringArray `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	ExpiresAt          *time.Time     `json:"expires_at"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
	APIKeys            []APIKey       `gorm:"constraint:OnDelete:CASCADE" json:"-"`
}

type APIKey struct {
	ID                 string         `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID           string         `gorm:"type:uuid;not null;index:api_keys_tenant_idx,priority:1" json:"tenant_id"`
	Name               string         `gorm:"not null" json:"name"`
	KeyHash            []byte         `gorm:"uniqueIndex;not null" json:"-"`
	Prefix             string         `gorm:"not null" json:"prefix"`
	Enabled            bool           `gorm:"not null;default:true" json:"enabled"`
	RateLimitPerMinute *int           `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64         `json:"token_limit_daily"`
	ModelAllowlist     pq.StringArray `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	ExpiresAt          *time.Time     `json:"expires_at"`
	LastUsedAt         *time.Time     `json:"last_used_at"`
	CreatedAt          time.Time      `gorm:"index:api_keys_tenant_idx,priority:2,sort:desc" json:"created_at"`
}

type ModelPrice struct {
	Model                      string    `gorm:"primaryKey" json:"model"`
	InputNanoUSDPerToken       int64     `gorm:"not null" json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken      int64     `gorm:"not null" json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken int64     `gorm:"not null" json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken  int64     `gorm:"not null" json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken   int64     `gorm:"not null" json:"reasoning_nano_usd_per_token"`
	Source                     string    `gorm:"not null;default:admin" json:"source"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

type BillingLedger struct {
	ID                  string    `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID            string    `gorm:"type:uuid;not null;index:billing_ledger_tenant_idx,priority:1" json:"tenant_id"`
	RequestID           *string   `gorm:"type:uuid;index" json:"request_id"`
	Kind                string    `gorm:"not null" json:"kind"`
	AmountNanoUSD       int64     `gorm:"not null" json:"amount_nano_usd"`
	BalanceAfterNanoUSD int64     `gorm:"not null" json:"balance_after_nano_usd"`
	Note                string    `gorm:"not null;default:''" json:"note"`
	CreatedAt           time.Time `gorm:"index:billing_ledger_tenant_idx,priority:2,sort:desc" json:"created_at"`
}

type RequestLog struct {
	ID               string    `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID         string    `gorm:"type:uuid;not null;index:request_logs_tenant_started_idx,priority:1" json:"tenant_id"`
	APIKeyID         string    `gorm:"type:uuid;not null;index" json:"api_key_id"`
	CPARequestID     string    `gorm:"index" json:"cpa_request_id,omitempty"`
	Model            string    `gorm:"not null;default:''" json:"model"`
	Provider         string    `json:"provider,omitempty"`
	AuthIndex        string    `gorm:"index" json:"auth_index,omitempty"`
	Method           string    `gorm:"not null" json:"method"`
	Path             string    `gorm:"not null" json:"path"`
	StatusCode       int       `gorm:"not null;default:0" json:"status_code"`
	Stream           bool      `gorm:"not null;default:false" json:"stream"`
	PromptTokens     int64     `gorm:"not null;default:0" json:"prompt_tokens"`
	CompletionTokens int64     `gorm:"not null;default:0" json:"completion_tokens"`
	CachedTokens     int64     `gorm:"not null;default:0" json:"cached_tokens"`
	CacheWriteTokens int64     `gorm:"not null;default:0" json:"cache_write_tokens"`
	ReasoningTokens  int64     `gorm:"not null;default:0" json:"reasoning_tokens"`
	TotalTokens      int64     `gorm:"not null;default:0" json:"total_tokens"`
	CostNanoUSD      *int64    `json:"cost_nano_usd"`
	PricingComplete  bool      `gorm:"not null;default:false" json:"pricing_complete"`
	Settled          bool      `gorm:"not null;default:false;index" json:"settled"`
	ReservedNanoUSD  int64     `gorm:"not null;default:0" json:"reserved_nano_usd"`
	LatencyMS        int64     `gorm:"not null;default:0" json:"latency_ms"`
	ErrorMessage     string    `json:"error_message,omitempty"`
	StartedAt        time.Time `gorm:"index:request_logs_tenant_started_idx,priority:2,sort:desc;index" json:"started_at"`
	CompletedAt      time.Time `json:"completed_at"`
}

type Invitation struct {
	ID             string     `gorm:"type:uuid;primaryKey" json:"id"`
	TokenHash      []byte     `gorm:"uniqueIndex;not null" json:"-"`
	Email          string     `gorm:"not null;default:'';index" json:"email,omitempty"`
	ExpiresAt      time.Time  `gorm:"not null;index" json:"expires_at"`
	UsedAt         *time.Time `json:"used_at,omitempty"`
	UsedByTenantID *string    `gorm:"type:uuid" json:"used_by_user_id,omitempty"`
	RevokedAt      *time.Time `json:"revoked_at,omitempty"`
	CreatedAt      time.Time  `gorm:"not null" json:"created_at"`
}
