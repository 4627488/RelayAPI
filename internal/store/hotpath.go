package store

import (
	"sync"
	"time"

	"gorm.io/gorm"
)

const keyTouchMinGap = time.Minute

type keyTouchState struct {
	mu     sync.Mutex
	last   map[string]time.Time
	minGap time.Duration
}

func newKeyTouchState() *keyTouchState {
	return &keyTouchState{last: make(map[string]time.Time), minGap: keyTouchMinGap}
}

func (t *keyTouchState) ShouldWrite(id string, now time.Time) bool {
	if t == nil || id == "" {
		return true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if prev, ok := t.last[id]; ok && now.Sub(prev) < t.minGap {
		return false
	}
	t.last[id] = now
	if len(t.last) > 4096 {
		cutoff := now.Add(-t.minGap)
		for key, at := range t.last {
			if at.Before(cutoff) {
				delete(t.last, key)
			}
		}
	}
	return true
}

// localCalendarDate is the civil day of at in the process timezone, stored as
// UTC midnight so a Postgres date column does not shift across a local offset.
func localCalendarDate(at time.Time) time.Time {
	year, month, day := at.In(time.Local).Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func calendarDateEquals(day *time.Time, at time.Time) bool {
	if day == nil || day.IsZero() {
		return false
	}
	want := localCalendarDate(at)
	got := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	return got.Equal(want)
}

func dailyTokensForDay(used int64, day *time.Time, now time.Time) int64 {
	if !calendarDateEquals(day, now) {
		return 0
	}
	return used
}

func (k KeyContext) DailyTokenUsage(now time.Time) (tenant, key int64) {
	return dailyTokensForDay(k.TenantDailyTokens, k.TenantDailyTokensDay, now),
		dailyTokensForDay(k.TokensUsedToday, k.TokensUsedOn, now)
}

func applyDailyTokenDelta(tx *gorm.DB, tenantID, keyID string, started time.Time, previous, next int64) error {
	delta := next - previous
	if delta == 0 {
		return nil
	}
	day := localCalendarDate(started)
	if err := tx.Exec(`
UPDATE tenants SET
	daily_tokens_used = CASE WHEN daily_tokens_day = ? THEN daily_tokens_used + ? ELSE GREATEST(?, 0) END,
	daily_tokens_day = ?
WHERE id = ?`, day, delta, delta, day, tenantID).Error; err != nil {
		return err
	}
	return tx.Exec(`
UPDATE api_keys SET
	daily_tokens_used = CASE WHEN daily_tokens_day = ? THEN daily_tokens_used + ? ELSE GREATEST(?, 0) END,
	daily_tokens_day = ?
WHERE id = ?`, day, delta, delta, day, keyID).Error
}
