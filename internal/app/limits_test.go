package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestEnforceLimitsSkipsUsageQueryWhenNoDailyLimitExists(t *testing.T) {
	a := &App{}
	if err := a.enforceLimits(context.Background(), store.KeyContext{}); err != nil {
		t.Fatal(err)
	}
}

func TestEnforceMinuteLimitKeepsItsActualResetAcrossRejections(t *testing.T) {
	keyID := t.Name()
	limit := 1
	key := store.KeyContext{APIKey: store.APIKey{ID: keyID, RateLimitPerMinute: &limit}}
	a := &App{}
	t.Cleanup(func() {
		rateState.Lock()
		delete(rateState.requests, keyID)
		rateState.Unlock()
	})
	if err := a.enforceLimits(t.Context(), key); err != nil {
		t.Fatal(err)
	}
	rateState.Lock()
	wantReset := rateState.requests[keyID][0].Add(time.Minute)
	rateState.Unlock()
	for range 3 {
		var rejected *requestLimitError
		if err := a.enforceLimits(t.Context(), key); !errors.As(err, &rejected) || rejected.Code != "api_key_rate_limit_exceeded" || !rejected.ResetsAt.Equal(wantReset) {
			t.Fatalf("minute limit did not retain its real admission boundary: %+v, err=%v", rejected, err)
		}
	}
}
