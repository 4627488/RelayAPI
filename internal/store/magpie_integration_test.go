package store

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestMagpieAllOutcomesAndArchiveKeepIdenticalMetrics(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := database.DB()
	defer conn.Close()
	tx := database.Begin()
	defer tx.Rollback()
	s := Store{DB: tx}
	tenant, key := identity.NewID(), identity.NewID()
	if err := tx.Create(&db.Tenant{ID: tenant, Name: "metering", OwnerEmail: tenant + "@example.test", PasswordHash: "test", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err := tx.Create(&db.APIKey{ID: key, TenantID: tenant, Name: "metering", KeyHash: []byte(key), Prefix: "test", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().AddDate(0, 0, -2).Truncate(24 * time.Hour).Add(23*time.Hour + 45*time.Minute)
	cases := []LogInput{
		{Usage: Usage{Input: 100, Output: 50, CacheRead: 300, CacheWrite: 100, CacheWrite1h: 50, Reasoning: 20}, CostNanoUSD: int64Pointer(1000), PricingComplete: true, Settled: true, FirstTokenMS: int64Pointer(1000), FirstTextMS: int64Pointer(1500), FlowMS: 2500, LatencyMS: 4000},
		{Usage: Usage{Input: 20, Output: 5, CacheUnknown: true}, UsageQuality: "missing"},
		{Usage: Usage{Input: 7, Output: 3}, CostNanoUSD: int64Pointer(0), PricingComplete: true, Settled: true},
		{Usage: Usage{Input: 11, Output: 2}, StatusCode: 502, ErrorCode: "upstream_error"},
		{Usage: Usage{Input: 3, Output: 1}, StatusCode: 499, Canceled: true},
		{Rejected: true, StatusCode: 429, ErrorCode: "local_limit", PricingComplete: true, CostNanoUSD: int64Pointer(0)},
	}
	for i, l := range cases {
		l.ID = identity.NewID()
		l.TenantID = tenant
		l.APIKeyID = key
		l.APIKeyName = "metering"
		l.Model = "model"
		l.Method = "POST"
		l.Path = "/v1/responses"
		l.StartedAt = at.Add(time.Duration(i) * time.Minute)
		l.CompletedAt = l.StartedAt.Add(4 * time.Second)
		l.Usage.Total = l.Usage.Tokens()
		if l.StatusCode == 0 {
			l.StatusCode = 200
		}
		if err := s.WriteLog(t.Context(), l); err != nil {
			t.Fatal(err)
		}
	}
	before, err := s.UsageReport(t.Context(), tenant, 7, "Asia/Kathmandu")
	if err != nil {
		t.Fatal(err)
	}
	total := before["summary"].(UsageTotals)
	if total.Requests != 5 || total.Errors != 1 || total.Canceled != 1 || total.Rejected != 1 || total.Tokens != 202 || total.Unpriced != 3 || total.CostNanoUSD != 1000 || total.CacheWrite1hTokens != 50 {
		t.Fatalf("wrong totals: %+v", total)
	}
	if total.CacheHitRate == nil || *total.CacheHitRate != 300.0/521.0 {
		t.Fatalf("unknown cache polluted hit rate: %+v", total)
	}
	if total.DecodeOut != 30 || total.DecodeMS != 2500 || total.DecodeN != 1 {
		t.Fatalf("wrong weighted speed: %+v", total)
	}
	page, err := s.QueryLogs(t.Context(), LogQuery{TenantID: tenant})
	if err != nil || page.Total != 6 {
		t.Fatalf("request history missing outcomes: %+v %v", page, err)
	}
	for _, status := range []string{"canceled", "rejected", "error"} {
		p, err := s.QueryLogs(t.Context(), LogQuery{TenantID: tenant, Status: status})
		if err != nil || p.Total != 1 {
			t.Fatalf("%s filter: %+v %v", status, p, err)
		}
	}
	stats := RetentionStats{}
	if _, err := s.compactRequestLogs(t.Context(), time.Now().Add(-time.Hour), 1000, &stats); err != nil {
		t.Fatal(err)
	}
	after, err := s.UsageReport(t.Context(), tenant, 7, "Asia/Kathmandu")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"summary", "daily", "models", "api_keys"} {
		a, _ := json.Marshal(before[field])
		b, _ := json.Marshal(after[field])
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("retention changed %s: before=%s after=%s", field, a, b)
		}
	}
	if _, err := s.compactRequestLogs(t.Context(), time.Now().Add(-time.Hour), 1000, &stats); err != nil {
		t.Fatal(err)
	}
	again, err := s.UsageReport(t.Context(), tenant, 7, "Asia/Kathmandu")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after["summary"], again["summary"]) {
		t.Fatal("repeat retention double-counted")
	}
}

func TestUnknownCacheReadIsExcludedFromBothSidesOfHitRate(t *testing.T) {
	total := UsageTotals{PromptTokens: 100, CachedTokens: 900, CacheUnknownTokens: 900, CacheUnknownReadTokens: 800}
	total.finish()
	if total.CacheHitRate == nil || *total.CacheHitRate != 1 {
		t.Fatalf("unknown cached reads inflated hit rate: %+v", total)
	}
	total.CacheUnknownTokens = 1000
	total.finish()
	if total.CacheHitRate != nil {
		t.Fatal("no known cache samples must remain unknown")
	}
}
