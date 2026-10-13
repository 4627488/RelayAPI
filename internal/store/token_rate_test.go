package store

import (
	"context"
	"os"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestTokenRatePoints(t *testing.T) {
	start := time.Date(2026, 10, 13, 0, 0, 0, 0, time.FixedZone("browser", 8*3600))
	points := tokenRatePoints(start, start.Add(150*time.Second), map[int64]int64{start.Unix() / 60: 180, start.Add(2*time.Minute).Unix() / 60: 90})
	if len(points) != 3 || points[0].TokensPerSecond != 3 || points[1].TokensPerSecond != 0 || points[2].TokensPerSecond != 3 {
		t.Fatalf("unexpected rates: %+v", points)
	}
	if points[0].Time.Format(time.RFC3339) != "2026-10-13T00:00:00+08:00" {
		t.Fatal("lost local day boundary")
	}
	if got := tokenRatePoints(start, start, nil); len(got) != 1 || got[0].TokensPerSecond != 0 {
		t.Fatalf("midnight: %+v", got)
	}
}

func TestTodayTokenRateIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	if err := tx.Exec(`CREATE TEMP TABLE request_logs (completed_at timestamptz, log_unit text, completion_tokens bigint, total_tokens bigint) ON COMMIT DROP`).Error; err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 13, 0, 0, 0, 0, time.FixedZone("test", 8*3600))
	for _, row := range []struct {
		at     time.Time
		unit   string
		tokens int
	}{
		{start.Add(-time.Second), "step", 9999},
		{start.Add(10 * time.Second), "step", 60},
		{start.Add(20 * time.Second), "step", 120},
		{start.Add(2 * time.Minute), "step", 90},
		{start.Add(time.Minute), "connection", 9999},
		{start.Add(time.Minute), "prewarm", 9999},
		{start.Add(3 * time.Minute), "step", 9999},
	} {
		// Input-heavy totals must not inflate output speed.
		if err := tx.Exec("INSERT INTO request_logs VALUES (?, ?, ?, ?)", row.at, row.unit, row.tokens, row.tokens+100000).Error; err != nil {
			t.Fatal(err)
		}
	}
	points, err := (Store{DB: tx}).TodayTokenRate(context.Background(), start.Add(150*time.Second), 480)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 3 || !points[0].Time.Equal(start) || points[0].Tokens != 180 || points[0].TokensPerSecond != 3 || points[1].TokensPerSecond != 0 || points[2].TokensPerSecond != 3 {
		t.Fatalf("unexpected buckets: %+v", points)
	}
}
