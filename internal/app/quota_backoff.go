package app

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
)

type quotaProbeBackoff struct {
	mu      sync.Mutex
	entries map[string]quotaProbeAttempt
}

type quotaProbeAttempt struct {
	running bool
	delay   time.Duration
	retryAt time.Time
}

// begin serializes manual and automatic probes for the same credential.
func (b *quotaProbeBackoff) begin(id string, now time.Time) (bool, time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	entry := b.entries[id]
	if entry.running || now.Before(entry.retryAt) {
		return false, entry.retryAt
	}
	if b.entries == nil {
		b.entries = make(map[string]quotaProbeAttempt)
	}
	entry.running = true
	b.entries[id] = entry
	return true, time.Time{}
}

func (b *quotaProbeBackoff) finish(id string, now time.Time, err error) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	entry := b.entries[id]
	entry.running = false
	var upstream *gateway.QuotaHTTPError
	if errors.As(err, &upstream) && upstream.StatusCode == http.StatusTooManyRequests {
		entry.delay = min(max(time.Minute, entry.delay*2), 15*time.Minute)
		entry.retryAt = now.Add(entry.delay)
		if upstream.RetryAt.After(entry.retryAt) {
			entry.retryAt = upstream.RetryAt
		}
		b.entries[id] = entry
		return entry.retryAt
	}
	if err == nil {
		delete(b.entries, id)
	} else {
		b.entries[id] = entry
	}
	return time.Time{}
}
