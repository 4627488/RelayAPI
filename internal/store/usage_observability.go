package store

import (
	"context"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"gorm.io/gorm"
)

// UsageObservability covers retained request rows, never archived daily rollups.
// Percentiles cannot be reconstructed by averaging archived aggregates.
type UsageObservability struct {
	RetainedRequests  int64           `json:"retained_requests"`
	StepSamples       int64           `json:"step_samples"`
	FirstTokenSamples int64           `json:"first_token_samples"`
	TTFTSamples       int64           `json:"ttft_samples"`
	LatencyP50        *float64        `json:"latency_p50_ms"`
	LatencyP95        *float64        `json:"latency_p95_ms"`
	FirstTokenP50     *float64        `json:"first_token_p50_ms"`
	FirstTokenP95     *float64        `json:"first_token_p95_ms"`
	TTFTP50           *float64        `json:"ttft_p50_ms" gorm:"column:ttft_p50"`
	TTFTP95           *float64        `json:"ttft_p95_ms" gorm:"column:ttft_p95"`
	FirstObservedAt   *time.Time      `json:"first_observed_at"`
	LastObservedAt    *time.Time      `json:"last_observed_at"`
	UnpricedRequests  int64           `json:"unpriced_requests"`
	UnsettledRequests int64           `json:"unsettled_requests"`
	Failures          []UsageFailure  `json:"failures" gorm:"-"`
	Providers         []UsageProvider `json:"providers" gorm:"-"`
}

type UsageFailure struct {
	Model      string `json:"model"`
	StatusCode int    `json:"status_code"`
	ErrorCode  string `json:"error_code"`
	Requests   int64  `json:"requests"`
}

type UsageProvider struct {
	Provider    string `json:"provider"`
	Requests    int64  `json:"requests"`
	Errors      int64  `json:"errors"`
	Tokens      int64  `json:"tokens"`
	CostNanoUSD int64  `json:"cost_nano_usd"`
}

func (s Store) usageObservability(ctx context.Context, tenantID string, since time.Time) (UsageObservability, error) {
	base := func() *gorm.DB {
		query := scoped(ctx, s.DB).Model(&db.RequestLog{}).Where("started_at >= ?", since)
		if tenantID != "" {
			query = query.Where("tenant_id = ?", tenantID)
		}
		return query
	}
	result := UsageObservability{Failures: []UsageFailure{}, Providers: []UsageProvider{}}
	err := base().Select(`count(*) AS retained_requests,
 count(*) FILTER (WHERE log_unit = 'step') AS step_samples,
 count(first_token_ms) FILTER (WHERE log_unit = 'step' AND first_token_ms >= 0) AS first_token_samples,
 count(ttftms) FILTER (WHERE log_unit = 'step' AND ttftms >= 0) AS ttft_samples,
 percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE log_unit = 'step') AS latency_p50,
 percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE log_unit = 'step') AS latency_p95,
 percentile_cont(0.50) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE log_unit = 'step' AND first_token_ms >= 0) AS first_token_p50,
 percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE log_unit = 'step' AND first_token_ms >= 0) AS first_token_p95,
 percentile_cont(0.50) WITHIN GROUP (ORDER BY ttftms) FILTER (WHERE log_unit = 'step' AND ttftms >= 0) AS ttft_p50,
 percentile_cont(0.95) WITHIN GROUP (ORDER BY ttftms) FILTER (WHERE log_unit = 'step' AND ttftms >= 0) AS ttft_p95,
 min(started_at) AS first_observed_at, max(started_at) AS last_observed_at,
 count(*) FILTER (WHERE NOT pricing_complete) AS unpriced_requests,
 count(*) FILTER (WHERE NOT settled) AS unsettled_requests`).Scan(&result).Error
	if err != nil {
		return result, err
	}
	err = base().Select("model, status_code, COALESCE(error_code, '') AS error_code, count(*) AS requests").
		Where("status_code = 0 OR status_code >= 400 OR COALESCE(error_code, '') <> ''").
		Group("model, status_code, error_code").Order("requests DESC, model, status_code, error_code").Limit(20).Scan(&result.Failures).Error
	if err != nil {
		return result, err
	}
	// Provider-wide operational attribution is only included in the global admin report.
	if tenantID == "" {
		err = base().Select("COALESCE(provider, '') AS provider, count(*) AS requests, " + requestLogUnitErrorSQL() + " AS errors, COALESCE(sum(total_tokens),0) AS tokens, COALESCE(sum(cost_nano_usd),0) AS cost_nano_usd").
			Group("provider").Order("cost_nano_usd DESC, provider").Scan(&result.Providers).Error
	}
	return result, err
}
