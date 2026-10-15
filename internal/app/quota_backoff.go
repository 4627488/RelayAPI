package app

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"strings"
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

func (b *quotaProbeBackoff) finish(id string, now time.Time, err error, provider string) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	entry := b.entries[id]
	entry.running = false
	var upstream *gateway.QuotaHTTPError
	if err != nil && !errors.Is(err, context.Canceled) {
		minimum := time.Minute
		if strings.EqualFold(provider, "claude") || strings.EqualFold(provider, "anthropic") {
			minimum = 5 * time.Minute
		}
		entry.delay = min(max(minimum, entry.delay*2), time.Hour)
		entry.retryAt = now.Add(entry.delay + time.Duration(rand.Int64N(int64(entry.delay/5)+1)))
		if errors.As(err, &upstream) && (upstream.StatusCode == http.StatusTooManyRequests || upstream.StatusCode == http.StatusServiceUnavailable) && upstream.RetryAt.After(entry.retryAt) {
			entry.retryAt = upstream.RetryAt
		}
		b.entries[id] = entry
		return entry.retryAt
	}
	delete(b.entries, id)
	return time.Time{}
}
