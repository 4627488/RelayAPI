package app

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func saturatingMultiply64(left, right int64) int64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

func (a *App) releaseReservation(requestID string, billable bool) {
	if !billable {
		return
	}
	if err := a.store.ReleaseRequestReservation(context.Background(), requestID); err != nil {
		slog.Error("release request reservation", "request_id", requestID, "error", err)
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

type requestLimitError struct {
	Code    string
	Message string
}

func (e *requestLimitError) Error() string { return e.Message }

func (a *App) enforceLimits(ctx context.Context, key store.KeyContext) error {
	if key.TenantTokenLimit != nil || key.TokenLimitDaily != nil {
		tenantTokens, keyTokens, err := a.store.DailyTokens(ctx, key.TenantID, key.ID)
		if err != nil {
			return err
		}
		if key.TenantTokenLimit != nil && tenantTokens >= *key.TenantTokenLimit {
			return &requestLimitError{Code: "tenant_daily_token_limit_exceeded", Message: "租户今日 Token 使用额度已用尽，请等待次日重置"}
		}
		if key.TokenLimitDaily != nil && keyTokens >= *key.TokenLimitDaily {
			return &requestLimitError{Code: "api_key_daily_token_limit_exceeded", Message: "该 API Key 今日 Token 使用额度已用尽，请等待次日重置"}
		}
	}
	// Per-minute admission is intentionally process-local; PostgreSQL remains the source of truth for billing.
	limit := key.RateLimitPerMinute
	if limit == nil {
		limit = key.TenantRateLimit
	}
	if limit != nil && !a.allowRate(key.ID, *limit) {
		return &requestLimitError{Code: "api_key_rate_limit_exceeded", Message: "该 API Key 每分钟请求次数已达上限，请稍后重试"}
	}
	return nil
}

func expired(value *time.Time) bool { return value != nil && !value.After(time.Now()) }
