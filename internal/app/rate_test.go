package app

import (
	"testing"
	"time"
)

func TestRateLimiterDoesNotRetainRejectedAttempts(t *testing.T) {
	key := "bounded-rejections"
	rateState.Lock()
	delete(rateState.requests, key)
	rateState.Unlock()
	a := &App{}
	if !a.allowRate(key, 2) || !a.allowRate(key, 2) {
		t.Fatal("requests within the limit were rejected")
	}
	for range 10_000 {
		if a.allowRate(key, 2) {
			t.Fatal("request beyond the limit was accepted")
		}
	}
	rateState.Lock()
	retained := len(rateState.requests[key])
	delete(rateState.requests, key)
	rateState.Unlock()
	if retained != 2 {
		t.Fatalf("retained timestamps = %d, want 2", retained)
	}
}

func TestRateLimiterSweepsExpiredKeys(t *testing.T) {
	rateState.Lock()
	rateState.requests["expired-key"] = []time.Time{time.Now().Add(-2 * time.Minute)}
	rateState.lastSweep = time.Time{}
	rateState.Unlock()
	a := &App{}
	if !a.allowRate("live-key", 1) {
		t.Fatal("live request was rejected")
	}
	rateState.Lock()
	_, expiredExists := rateState.requests["expired-key"]
	delete(rateState.requests, "live-key")
	rateState.Unlock()
	if expiredExists {
		t.Fatal("expired key state was not swept")
	}
}
