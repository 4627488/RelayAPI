package db

import (
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
)

func TestMagpieMigrationPreservesChargesAndDoesNotReinventHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not configured")
	}
	database, err := Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := database.DB()
	defer conn.Close()
	tx := database.Begin()
	defer tx.Rollback()
	// Temp legacy archive shadows any real one, keeping the test isolated.
	if err := tx.Exec(`CREATE TEMP TABLE usage_daily_rollups (LIKE usage_rollups_v2 INCLUDING DEFAULTS) ON COMMIT DROP`).Error; err != nil {
		t.Fatal(err)
	}
	if err := tx.Exec(`ALTER TABLE usage_daily_rollups ALTER COLUMN day TYPE date USING (day AT TIME ZONE 'UTC')::date`).Error; err != nil {
		t.Fatal(err)
	}
	if err := tx.Exec(`SET LOCAL TIME ZONE 'Asia/Tokyo'`).Error; err != nil {
		t.Fatal(err)
	}
	legacyDay := time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC)
	id, tenant, key := identity.NewID(), identity.NewID(), identity.NewID()
	cost := int64(123456)
	firstByte, firstContent := int64(100), int64(700)
	legacy := RequestLog{ID: id, TenantID: tenant, APIKeyID: key, Model: "legacy", MeteringVersion: 1, PromptTokens: 100, CompletionTokens: 50, CachedTokens: 30, CacheWriteTokens: 20, TotalTokens: 170, CostNanoUSD: &cost, PricingComplete: true, Settled: true, TTFTMS: &firstByte, FirstTokenMS: &firstContent, StartedAt: time.Now(), CompletedAt: time.Now(), LogUnit: "step"}
	if err := tx.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := tx.Exec(`INSERT INTO usage_daily_rollups(day,tenant_id,model,api_key_id,requests,prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens,total_tokens,cost_nano_usd,updated_at) VALUES (?,?,'legacy','',1,100,50,30,20,170,123456,?)`, legacyDay, tenant, time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	apply := func() {
		t.Helper()
		for _, m := range migrations {
			if m.version == 16 {
				for _, statement := range m.statements {
					if err := tx.Exec(statement).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
		}
	}
	apply()
	apply()
	var got RequestLog
	if err := tx.First(&got, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if got.LegacyUsage == "" || got.PromptTokens != 70 || got.TotalTokens != 120 || got.CostNanoUSD == nil || *got.CostNanoUSD != cost || !got.CacheUnknown || got.MeteringVersion != 2 || got.FirstByteMS == nil || *got.FirstByteMS != 100 || got.TTFTMS == nil || *got.TTFTMS != 700 {
		t.Fatalf("migration changed evidence/charge: %+v", got)
	}
	var rows []UsageDailyRollup
	if err := tx.Where("tenant_id = ?", tenant).Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !rows[0].Day.UTC().Equal(legacyDay) || rows[0].APIKeyID != "" || rows[0].PromptTokens != 70 || rows[0].TotalTokens != 120 || rows[0].CacheUnknownTokens != 120 || rows[0].CostNanoUSD != cost {
		t.Fatalf("legacy archive fabricated/doubled: %+v", rows)
	}
}
