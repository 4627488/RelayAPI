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
	err := a.store.ReleaseRequestReservation(context.Background(), requestID)
	a.observePersistence("reservation_release", err)
	if err != nil {
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
	Code     string
	Message  string
	ResetsAt time.Time
}

func (e *requestLimitError) Error() string { return e.Message }

func (a *App) enforceLimits(ctx context.Context, key store.KeyContext) error {
	if key.TenantTokenLimit != nil || key.TokenLimitDaily != nil {
		now := time.Now()
		year, month, day := now.In(time.Local).Date()
		// DailyTokens uses the process civil day (UTC in the production image).
		// Keep the advertised reset on that exact boundary, including DST.
		resetsAt := time.Date(year, month, day+1, 0, 0, 0, 0, time.Local).UTC()
		tenantTokens, keyTokens, err := a.store.DailyTokens(ctx, key.TenantID, key.ID)
		if err != nil {
			return err
		}
		if key.TenantTokenLimit != nil && tenantTokens >= *key.TenantTokenLimit {
			return &requestLimitError{Code: "tenant_daily_token_limit_exceeded", Message: "Your account has reached its daily token limit. Wait for the daily reset.", ResetsAt: resetsAt}
		}
		if key.TokenLimitDaily != nil && keyTokens >= *key.TokenLimitDaily {
			return &requestLimitError{Code: "api_key_daily_token_limit_exceeded", Message: "This API key has reached its daily token limit. Wait for the daily reset.", ResetsAt: resetsAt}
		}
	}
	// Per-minute admission is intentionally process-local; PostgreSQL remains the source of truth for billing.
	limit := key.RateLimitPerMinute
	if limit == nil {
		limit = key.TenantRateLimit
	}
	if limit != nil {
		if allowed, resetsAt := a.allowRateAt(key.ID, *limit, time.Now()); !allowed {
			return &requestLimitError{Code: "api_key_rate_limit_exceeded", Message: "This API key has reached its per-minute request limit. Wait until the request window resets.", ResetsAt: resetsAt}
		}
	}
	return nil
}

func expired(value *time.Time) bool { return value != nil && !value.After(time.Now()) }
