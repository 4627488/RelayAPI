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
	MustChangePassword bool           `gorm:"not null;default:false" json:"must_change_password"`
	PasswordVersion    int64          `gorm:"not null;default:0" json:"-"`
	Enabled            bool           `gorm:"not null;default:true" json:"enabled"`
	IsAdmin            bool           `gorm:"not null;default:false;index" json:"is_admin"`
	BalanceNanoUSD     int64          `gorm:"not null;default:0" json:"balance_nano_usd"`
	RateLimitPerMinute *int           `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64         `json:"token_limit_daily"`
	TokensUsedToday    int64          `gorm:"column:daily_tokens_used;not null;default:0" json:"-"`
	TokensUsedOn       *time.Time     `gorm:"column:daily_tokens_day;type:date" json:"-"`
	ModelAllowlist     pq.StringArray `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	ExpiresAt          *time.Time     `json:"expires_at"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
	APIKeys            []APIKey       `gorm:"constraint:OnDelete:CASCADE" json:"-"`
}

type APIKey struct {
	ID                 string             `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID           string             `gorm:"type:uuid;not null;index:api_keys_tenant_idx,priority:1" json:"tenant_id"`
	Name               string             `gorm:"not null" json:"name"`
	KeyHash            []byte             `gorm:"uniqueIndex;not null" json:"-"`
	KeyCiphertext      []byte             `gorm:"type:bytea" json:"-"`
	Prefix             string             `gorm:"not null" json:"prefix"`
	Recoverable        bool               `gorm:"-" json:"recoverable"`
	Enabled            bool               `gorm:"not null;default:true" json:"enabled"`
	RateLimitPerMinute *int               `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64             `json:"token_limit_daily"`
	TokensUsedToday    int64              `gorm:"column:daily_tokens_used;not null;default:0" json:"-"`
	TokensUsedOn       *time.Time         `gorm:"column:daily_tokens_day;type:date" json:"-"`
	ModelAllowlist     pq.StringArray     `gorm:"type:text[];not null;default:'{}'" json:"model_allowlist"`
	ModelAliases       []APIKeyModelAlias `gorm:"foreignKey:APIKeyID;constraint:OnDelete:CASCADE" json:"model_aliases"`
	ExpiresAt          *time.Time         `json:"expires_at"`
	LastUsedAt         *time.Time         `json:"last_used_at"`
	CreatedAt          time.Time          `gorm:"index:api_keys_tenant_idx,priority:2,sort:desc" json:"created_at"`
}

// APIKeyModelAlias exposes an additional client-visible model name for one API
// key. Model always stores the concrete model used for authorization, billing,
// subscription admission, and Upstream routing.
type APIKeyModelAlias struct {
	ID       string `gorm:"type:uuid;primaryKey" json:"id"`
	APIKeyID string `gorm:"type:uuid;not null;uniqueIndex:api_key_model_alias_identity,priority:1" json:"-"`
	Alias    string `gorm:"not null;uniqueIndex:api_key_model_alias_identity,priority:2" json:"alias"`
	Model    string `gorm:"not null;index" json:"model"`
}

type ModelPrice struct {
	Model                           string    `gorm:"primaryKey" json:"model"`
	InputNanoUSDPerToken            int64     `gorm:"not null" json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64     `gorm:"not null" json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64     `gorm:"not null" json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64     `gorm:"not null" json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64     `gorm:"not null" json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64     `gorm:"not null;default:0" json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64     `gorm:"not null;default:0" json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64     `gorm:"not null;default:0" json:"image_output_nano_usd_per_token"`
	Source                          string    `gorm:"not null;default:admin" json:"source"`
	Version                         string    `gorm:"not null;default:''" json:"version"`
	PriceMultiplier                 float64   `gorm:"not null;default:1" json:"price_multiplier"`
	UpdatedAt                       time.Time `json:"updated_at"`
}

// ModelCatalogPrice stores replaceable catalog data separately from administrator
// overrides. This preserves the resolution order admin > live catalog > bundled.
type ModelCatalogPrice struct {
	Model                           string    `gorm:"primaryKey" json:"model"`
	InputNanoUSDPerToken            int64     `gorm:"not null" json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64     `gorm:"not null" json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64     `gorm:"not null" json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64     `gorm:"not null" json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64     `gorm:"not null" json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64     `gorm:"not null;default:0" json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64     `gorm:"not null;default:0" json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64     `gorm:"not null;default:0" json:"image_output_nano_usd_per_token"`
	Source                          string    `gorm:"not null" json:"source"`
	Version                         string    `gorm:"not null" json:"version"`
	SourceModelID                   string    `gorm:"not null;default:''" json:"source_model_id"`
	RawJSON                         string    `gorm:"type:text;not null;default:''" json:"-"`
	UpdatedAt                       time.Time `json:"updated_at"`
}

type ModelAlias struct {
	Alias     string    `gorm:"primaryKey" json:"alias"`
	Model     string    `gorm:"not null;index" json:"model"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ModelPriceRule struct {
	ID         string    `gorm:"type:uuid;primaryKey" json:"id"`
	Model      string    `gorm:"not null;uniqueIndex:model_price_rule_identity,priority:1" json:"model"`
	Field      string    `gorm:"not null;uniqueIndex:model_price_rule_identity,priority:2" json:"field"`
	Value      string    `gorm:"not null;uniqueIndex:model_price_rule_identity,priority:3" json:"value"`
	Multiplier float64   `gorm:"not null;default:1" json:"multiplier"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
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

// UsageDailyRollup preserves reporting and billing analytics after individual
// request logs age out. Rows are added in the same transaction that deletes
// their source request logs, making the compaction idempotent.
type UsageDailyRollup struct {
	Day                        time.Time `gorm:"type:date;primaryKey" json:"day"`
	TenantID                   string    `gorm:"type:uuid;primaryKey;index" json:"tenant_id"`
	Model                      string    `gorm:"primaryKey" json:"model"`
	Requests                   int64     `gorm:"not null;default:0" json:"requests"`
	Errors                     int64     `gorm:"not null;default:0" json:"errors"`
	PromptTokens               int64     `gorm:"not null;default:0" json:"prompt_tokens"`
	CompletionTokens           int64     `gorm:"not null;default:0" json:"completion_tokens"`
	CachedTokens               int64     `gorm:"not null;default:0" json:"cached_tokens"`
	CacheWriteTokens           int64     `gorm:"not null;default:0" json:"cache_write_tokens"`
	ReasoningTokens            int64     `gorm:"not null;default:0" json:"reasoning_tokens"`
	ImageInputTokens           int64     `gorm:"not null;default:0" json:"image_input_tokens"`
	CachedImageInputTokens     int64     `gorm:"not null;default:0" json:"cached_image_input_tokens"`
	ImageOutputTokens          int64     `gorm:"not null;default:0" json:"image_output_tokens"`
	TotalTokens                int64     `gorm:"not null;default:0" json:"total_tokens"`
	CostNanoUSD                int64     `gorm:"not null;default:0" json:"cost_nano_usd"`
	SubscriptionCoveredNanoUSD int64     `gorm:"not null;default:0" json:"subscription_covered_nano_usd"`
	BalanceChargedNanoUSD      int64     `gorm:"not null;default:0" json:"balance_charged_nano_usd"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

type RequestLog struct {
	ID                           string    `gorm:"type:uuid;primaryKey" json:"id"`
	TenantID                     string    `gorm:"type:uuid;not null;index:request_logs_tenant_started_idx,priority:1" json:"tenant_id"`
	APIKeyID                     string    `gorm:"type:uuid;not null;index" json:"api_key_id"`
	ReservationRequestID         *string   `gorm:"type:uuid;index" json:"reservation_request_id,omitempty"`
	UpstreamRequestID            string    `gorm:"index" json:"upstream_request_id,omitempty"`
	UpstreamTraceID              string    `gorm:"index" json:"upstream_trace_id,omitempty"`
	UpstreamExecutionID          string    `gorm:"index" json:"upstream_execution_id,omitempty"`
	Model                        string    `gorm:"not null;default:''" json:"model"`
	RequestedModel               string    `gorm:"not null;default:''" json:"requested_model"`
	ActualModel                  string    `gorm:"not null;default:'';index" json:"actual_model"`
	ModelAlias                   string    `gorm:"not null;default:''" json:"model_alias"`
	Provider                     string    `json:"provider,omitempty"`
	ExecutorType                 string    `json:"executor_type,omitempty"`
	AuthType                     string    `json:"auth_type,omitempty"`
	AuthIndex                    string    `gorm:"index" json:"auth_index,omitempty"`
	ServiceTier                  string    `json:"service_tier,omitempty"`
	ResponseServiceTier          string    `json:"response_service_tier,omitempty"`
	ReasoningEffort              string    `json:"reasoning_effort,omitempty"`
	ParentSubscriptionID         *string   `gorm:"type:uuid;index" json:"parent_subscription_id,omitempty"`
	ChildSubscriptionID          *string   `gorm:"type:uuid;index" json:"child_subscription_id,omitempty"`
	ParentSubscriptionName       string    `gorm:"not null;default:''" json:"parent_subscription_name,omitempty"`
	ChildSubscriptionName        string    `gorm:"not null;default:''" json:"child_subscription_name,omitempty"`
	ChannelID                    string    `gorm:"not null;default:''" json:"channel_id,omitempty"`
	ChannelName                  string    `gorm:"not null;default:''" json:"channel_name,omitempty"`
	CredentialID                 string    `gorm:"not null;default:''" json:"credential_id,omitempty"`
	CredentialName               string    `gorm:"not null;default:''" json:"credential_name,omitempty"`
	CredentialEmail              string    `gorm:"not null;default:''" json:"credential_email,omitempty"`
	TenantName                   string    `gorm:"not null;default:''" json:"tenant_name"`
	APIKeyName                   string    `gorm:"not null;default:''" json:"api_key_name"`
	APIKeyPrefix                 string    `gorm:"not null;default:''" json:"api_key_prefix"`
	ClientName                   string    `gorm:"not null;default:''" json:"client_name"`
	ClientVersion                string    `gorm:"not null;default:''" json:"client_version"`
	UserAgent                    string    `gorm:"type:text;not null;default:''" json:"user_agent"`
	Method                       string    `gorm:"not null" json:"method"`
	Path                         string    `gorm:"not null" json:"path"`
	RequestType                  string    `gorm:"not null;default:'';index" json:"request_type"`
	StatusCode                   int       `gorm:"not null;default:0" json:"status_code"`
	Stream                       bool      `gorm:"not null;default:false" json:"stream"`
	RequestBodyBytes             int64     `gorm:"not null;default:0" json:"request_body_bytes"`
	ForwardedBodyBytes           int64     `gorm:"not null;default:0" json:"forwarded_body_bytes"`
	ResponseBodyBytes            int64     `gorm:"not null;default:0" json:"response_body_bytes"`
	PromptTokens                 int64     `gorm:"not null;default:0" json:"prompt_tokens"`
	CompletionTokens             int64     `gorm:"not null;default:0" json:"completion_tokens"`
	CachedTokens                 int64     `gorm:"not null;default:0" json:"cached_tokens"`
	CacheWriteTokens             int64     `gorm:"not null;default:0" json:"cache_write_tokens"`
	ReasoningTokens              int64     `gorm:"not null;default:0" json:"reasoning_tokens"`
	ImageInputTokens             int64     `gorm:"not null;default:0" json:"image_input_tokens"`
	CachedImageInputTokens       int64     `gorm:"not null;default:0" json:"cached_image_input_tokens"`
	ImageOutputTokens            int64     `gorm:"not null;default:0" json:"image_output_tokens"`
	TotalTokens                  int64     `gorm:"not null;default:0" json:"total_tokens"`
	CostNanoUSD                  *int64    `json:"cost_nano_usd"`
	PriceModel                   string    `gorm:"not null;default:''" json:"price_model"`
	PriceSource                  string    `gorm:"not null;default:''" json:"price_source"`
	PriceVersion                 string    `gorm:"not null;default:''" json:"price_version"`
	InputPriceNanoUSD            int64     `gorm:"not null;default:0" json:"input_price_nano_usd_per_token"`
	OutputPriceNanoUSD           int64     `gorm:"not null;default:0" json:"output_price_nano_usd_per_token"`
	CachedPriceNanoUSD           int64     `gorm:"not null;default:0" json:"cached_input_price_nano_usd_per_token"`
	CacheWritePriceNanoUSD       int64     `gorm:"not null;default:0" json:"cache_write_price_nano_usd_per_token"`
	ReasoningPriceNanoUSD        int64     `gorm:"not null;default:0" json:"reasoning_price_nano_usd_per_token"`
	ImageInputPriceNanoUSD       int64     `gorm:"not null;default:0" json:"image_input_price_nano_usd_per_token"`
	CachedImageInputPriceNanoUSD int64     `gorm:"not null;default:0" json:"cached_image_input_price_nano_usd_per_token"`
	ImageOutputPriceNanoUSD      int64     `gorm:"not null;default:0" json:"image_output_price_nano_usd_per_token"`
	PriceMultiplier              float64   `gorm:"not null;default:1" json:"price_multiplier"`
	PricingComplete              bool      `gorm:"not null;default:false" json:"pricing_complete"`
	Settled                      bool      `gorm:"not null;default:false;index" json:"settled"`
	ReservedNanoUSD              int64     `gorm:"not null;default:0" json:"reserved_nano_usd"`
	LatencyMS                    int64     `gorm:"not null;default:0" json:"latency_ms"`
	TTFTMS                       *int64    `json:"ttft_ms,omitempty"`
	StageTimings                 string    `gorm:"type:text;not null;default:'{}'" json:"stage_timings"`
	ErrorCode                    string    `json:"error_code,omitempty"`
	ErrorMessage                 string    `json:"error_message,omitempty"`
	StartedAt                    time.Time `gorm:"index:request_logs_tenant_started_idx,priority:2,sort:desc;index" json:"started_at"`
	CompletedAt                  time.Time `json:"completed_at"`
}

type RequestLogDetail struct {
	RequestLogID           string    `gorm:"type:uuid;primaryKey" json:"request_log_id"`
	RequestHeaders         string    `gorm:"type:text;not null;default:'{}'" json:"request_headers"`
	RequestBody            string    `gorm:"type:text;not null;default:''" json:"request_body"`
	RequestBodyTruncated   bool      `gorm:"not null;default:false" json:"request_body_truncated"`
	RequestBodyBytes       int64     `gorm:"not null;default:0" json:"request_body_bytes"`
	ForwardedHeaders       string    `gorm:"type:text;not null;default:'{}'" json:"forwarded_headers"`
	ForwardedBody          string    `gorm:"type:text;not null;default:''" json:"forwarded_body"`
	ForwardedBodyTruncated bool      `gorm:"not null;default:false" json:"forwarded_body_truncated"`
	ForwardedBodyBytes     int64     `gorm:"not null;default:0" json:"forwarded_body_bytes"`
	UpstreamStatus         int       `gorm:"not null;default:0" json:"upstream_status"`
	UpstreamHeaders        string    `gorm:"type:text;not null;default:'{}'" json:"upstream_headers"`
	UpstreamBody           string    `gorm:"type:text;not null;default:''" json:"upstream_body"`
	UpstreamBodyTruncated  bool      `gorm:"not null;default:false" json:"upstream_body_truncated"`
	UpstreamBodyBytes      int64     `gorm:"not null;default:0" json:"upstream_body_bytes"`
	ErrorName              string    `json:"error_name,omitempty"`
	ErrorMessage           string    `json:"error_message,omitempty"`
	ErrorStack             string    `gorm:"type:text" json:"error_stack,omitempty"`
	ErrorCause             string    `gorm:"type:text" json:"error_cause,omitempty"`
	ErrorDetail            string    `gorm:"type:text" json:"error_detail,omitempty"`
	StageTimings           string    `gorm:"type:text;not null;default:'{}'" json:"stage_timings"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`
}

type UpstreamLifecycleEvent struct {
	ID                  string     `gorm:"type:uuid;primaryKey" json:"id"`
	RequestLogID        string     `gorm:"type:uuid;not null;index:upstream_lifecycle_request_idx,priority:1" json:"request_log_id"`
	Event               string     `gorm:"not null;index:upstream_lifecycle_request_idx,priority:2" json:"event"`
	UpstreamExecutionID string     `gorm:"not null;default:'';index" json:"upstream_execution_id"`
	UpstreamTraceID     string     `gorm:"not null;default:'';index" json:"upstream_trace_id"`
	SourceFormat        string     `gorm:"not null;default:''" json:"source_format"`
	ToFormat            string     `gorm:"not null;default:''" json:"to_format"`
	Model               string     `gorm:"not null;default:''" json:"model"`
	RequestedModel      string     `gorm:"not null;default:''" json:"requested_model"`
	ModelAlias          string     `gorm:"not null;default:''" json:"model_alias"`
	Provider            string     `gorm:"not null;default:''" json:"provider"`
	ExecutorType        string     `gorm:"not null;default:''" json:"executor_type"`
	AuthType            string     `gorm:"not null;default:''" json:"auth_type"`
	AuthIndex           string     `gorm:"not null;default:''" json:"auth_index"`
	ServiceTier         string     `gorm:"not null;default:''" json:"service_tier"`
	ResponseServiceTier string     `gorm:"not null;default:''" json:"response_service_tier"`
	ReasoningEffort     string     `gorm:"not null;default:''" json:"reasoning_effort"`
	StatusCode          int        `gorm:"not null;default:0" json:"status_code"`
	Outcome             string     `gorm:"not null;default:''" json:"outcome"`
	ErrorMessage        string     `gorm:"type:text;not null;default:''" json:"error_message"`
	Headers             string     `gorm:"type:text;not null;default:'{}'" json:"headers"`
	ResponseHeaders     string     `gorm:"type:text;not null;default:'{}'" json:"response_headers"`
	Body                string     `gorm:"type:text;not null;default:''" json:"body"`
	OriginalRequest     string     `gorm:"type:text;not null;default:''" json:"original_request"`
	RequestBody         string     `gorm:"type:text;not null;default:''" json:"request_body"`
	RawJSON             string     `gorm:"type:text;not null;default:''" json:"-"`
	Processed           bool       `gorm:"not null;default:false;index" json:"processed"`
	CreatedAt           time.Time  `json:"created_at"`
	ProcessedAt         *time.Time `json:"processed_at,omitempty"`
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

// AgentSetup stores a short-lived encrypted setup claim behind an opaque
// capability token. Only the token hash is persisted.
type AgentSetup struct {
	TokenHash         []byte    `gorm:"type:bytea;primaryKey" json:"-"`
	TenantID          string    `gorm:"type:uuid;not null;index" json:"-"`
	PayloadCiphertext []byte    `gorm:"type:bytea;not null" json:"-"`
	ExpiresAt         time.Time `gorm:"not null;index" json:"-"`
	CreatedAt         time.Time `gorm:"not null" json:"-"`
}
