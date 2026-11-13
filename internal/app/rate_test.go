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

func TestRateLimiterResetTracksTheAdmissionThatFreesASlot(t *testing.T) {
	key := t.Name()
	t.Cleanup(func() {
		rateState.Lock()
		delete(rateState.requests, key)
		rateState.Unlock()
	})
	a := &App{}
	now := time.Now()
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		if allowed, reset := a.allowRateAt(key, 3, now.Add(offset)); !allowed || !reset.IsZero() {
			t.Fatalf("allowed admission = %v, reset=%v", allowed, reset)
		}
	}
	// Lowering a limit cannot admit the next call when only the oldest of
	// three retained calls expires: all three must age out for a limit of one.
	wantReset := now.Add(80 * time.Second)
	for _, offset := range []time.Duration{30 * time.Second, 50 * time.Second, 79 * time.Second} {
		if allowed, reset := a.allowRateAt(key, 1, now.Add(offset)); allowed || !reset.Equal(wantReset) {
			t.Fatalf("rejection at %v = %v, reset=%v want %v", offset, allowed, reset, wantReset)
		}
	}
	if allowed, reset := a.allowRateAt(key, 1, wantReset); !allowed || !reset.IsZero() {
		t.Fatalf("advertised reset did not free its slot: allowed=%v reset=%v", allowed, reset)
	}
}
