package store

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestHeatmapSurvivesRetentionAcrossTimezones(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	defer sqlDB.Close()
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	if err := tx.Exec("SET LOCAL TIME ZONE 'Asia/Tokyo'").Error; err != nil {
		t.Fatal(err)
	}
	tenantID, keyID := identity.NewID(), identity.NewID()
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	log := db.RequestLog{ID: identity.NewID(), TenantID: tenantID, APIKeyID: keyID, Model: "model-a", TotalTokens: 200,
		StartedAt: time.Date(2026, 8, 1, 23, 59, 0, 0, time.UTC), CompletedAt: time.Date(2026, 8, 2, 0, 1, 0, 0, time.UTC), StatusCode: 200}
	if err := tx.Create(&log).Error; err != nil {
		t.Fatal(err)
	}
	s := Store{DB: tx}
	before, err := s.TokenHeatmap(ctx, tenantID, now)
	if err != nil {
		t.Fatal(err)
	}
	if before.TotalTokens != 200 {
		t.Fatal("live usage missing")
	}
	stats := RetentionStats{}
	if _, err := s.compactRequestLogs(ctx, now.AddDate(0, 0, -1), 5000, &stats); err != nil {
		t.Fatal(err)
	}
	after, err := s.TokenHeatmap(ctx, tenantID, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("retention changed daily usage or model attribution")
	}
	if _, err := s.compactRequestLogs(ctx, now.AddDate(0, 0, -1), 5000, &stats); err != nil {
		t.Fatal(err)
	}
	again, err := s.TokenHeatmap(ctx, tenantID, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after, again) {
		t.Fatal("repeat retention double counted")
	}
}
