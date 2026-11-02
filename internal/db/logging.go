package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// SQL and bound parameters may contain keys, credentials and request bodies.
// Report database failures and slow queries without rendering the SQL callback.
type databaseLog struct{ level logger.LogLevel }

func (l databaseLog) LogMode(level logger.LogLevel) logger.Interface {
	l.level = level
	return l
}

func (l databaseLog) Info(ctx context.Context, message string, values ...any) {
	if l.level >= logger.Info {
		slog.DebugContext(ctx, fmt.Sprintf(message, values...), "component", "database")
	}
}

func (l databaseLog) Warn(ctx context.Context, message string, values ...any) {
	if l.level >= logger.Warn {
		slog.WarnContext(ctx, fmt.Sprintf(message, values...), "component", "database")
	}
}

func (l databaseLog) Error(ctx context.Context, message string, values ...any) {
	if l.level >= logger.Error {
		slog.ErrorContext(ctx, fmt.Sprintf(message, values...), "component", "database")
	}
}

func (l databaseLog) Trace(ctx context.Context, started time.Time, _ func() (string, int64), err error) {
	elapsed := time.Since(started)
	if l.level >= logger.Error && err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		slog.ErrorContext(ctx, "database query failed", "event", "database.query_failed", "duration_ms", elapsed.Milliseconds(), "error", err)
	} else if l.level >= logger.Warn && elapsed > time.Second {
		slog.WarnContext(ctx, "slow database query", "event", "database.slow_query", "duration_ms", elapsed.Milliseconds())
	}
}
