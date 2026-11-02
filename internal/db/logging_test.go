package db

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestDatabaseLogsNeverRenderSQL(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	l := databaseLog{level: logger.Warn}
	query := func() (string, int64) {
		t.Fatal("SQL callback must not render bound secrets")
		return "SELECT private-secret", 1
	}
	l.Trace(context.Background(), time.Now(), query, errors.New("connection closed"))
	l.Trace(context.Background(), time.Now().Add(-2*time.Second), query, nil)
	if !strings.Contains(output.String(), "database.query_failed") || !strings.Contains(output.String(), "database.slow_query") {
		t.Fatal("database diagnostics missing")
	}
	output.Reset()
	l.Trace(context.Background(), time.Now(), query, gorm.ErrRecordNotFound)
	l.LogMode(logger.Silent).Trace(context.Background(), time.Now(), query, errors.New("ignored"))
	if output.Len() != 0 {
		t.Fatal("silent or expected not-found query is noisy")
	}
}
