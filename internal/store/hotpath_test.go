package store

import (
	"testing"
	"time"
)

func TestKeyTouchStateDebouncesWrites(t *testing.T) {
	state := newKeyTouchState()
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	if !state.ShouldWrite("key-a", now) {
		t.Fatal("first touch must write")
	}
	if state.ShouldWrite("key-a", now.Add(30*time.Second)) {
		t.Fatal("touch within a minute must be skipped")
	}
	if !state.ShouldWrite("key-b", now.Add(30*time.Second)) {
		t.Fatal("a different key must not share debounce state")
	}
	if !state.ShouldWrite("key-a", now.Add(time.Minute)) {
		t.Fatal("touch after the debounce window must write")
	}
}

func TestCalendarDateUsesLocalCivilDay(t *testing.T) {
	local := time.Date(2026, 8, 19, 23, 30, 0, 0, time.Local)
	got := localCalendarDate(local)
	if got.Year() != 2026 || got.Month() != time.August || got.Day() != 19 || got.Location() != time.UTC {
		t.Fatalf("calendar date = %v", got)
	}
	stored := time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC)
	if !calendarDateEquals(&stored, local) {
		t.Fatal("UTC midnight of the civil day must match local now")
	}
	yesterday := time.Date(2026, 8, 18, 0, 0, 0, 0, time.UTC)
	if calendarDateEquals(&yesterday, local) {
		t.Fatal("previous civil day must not match")
	}
	if dailyTokensForDay(99, &yesterday, local) != 0 {
		t.Fatal("stale day counters must read as zero")
	}
	if dailyTokensForDay(99, &stored, local) != 99 {
		t.Fatal("current day counters must be visible")
	}
}

func TestKeyContextDailyTokenUsageIgnoresOtherDays(t *testing.T) {
	today := localCalendarDate(time.Now())
	yesterday := today.AddDate(0, 0, -1)
	key := KeyContext{
		APIKey:               APIKey{TokensUsedToday: 7, TokensUsedOn: &today},
		TenantDailyTokens:    11,
		TenantDailyTokensDay: &yesterday,
	}
	tenant, used := key.DailyTokenUsage(time.Now())
	if tenant != 0 || used != 7 {
		t.Fatalf("usage = %d, %d", tenant, used)
	}
}
