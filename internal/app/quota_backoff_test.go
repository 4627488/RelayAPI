package app

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestQuotaBackoffRateLimitRecoveryAndIsolation(t *testing.T) {
	var backoff quotaProbeBackoff
	now := time.Now()
	for _, delay := range []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute} {
		if ok, _ := backoff.begin("claude", now); !ok {
			t.Fatal("due probe was blocked")
		}
		err := fmt.Errorf("Claude quota request: %w", &gateway.QuotaHTTPError{StatusCode: http.StatusTooManyRequests})
		at := backoff.finish("claude", now, err)
		if !at.Equal(now.Add(delay)) {
			t.Fatalf("retry at %v, want %v", at, now.Add(delay))
		}
		if ok, _ := backoff.begin("claude", at.Add(-time.Nanosecond)); ok {
			t.Fatal("probe ignored cooldown")
		}
		if ok, _ := backoff.begin("codex", now); !ok {
			t.Fatal("rate limit affected a different credential")
		}
		backoff.finish("codex", now, nil)
		now = at
	}
	if ok, _ := backoff.begin("claude", now); !ok {
		t.Fatal("probe did not resume")
	}
	backoff.finish("claude", now, nil)
	backoff.begin("claude", now)
	at := backoff.finish("claude", now, &gateway.QuotaHTTPError{StatusCode: 429, RetryAt: now.Add(time.Hour)})
	if !at.Equal(now.Add(time.Hour)) {
		t.Fatal("upstream Retry-After was ignored")
	}
	backoff.begin("claude", at)
	backoff.finish("claude", at, nil)
	backoff.begin("claude", at)
	if got := backoff.finish("claude", at, &gateway.QuotaHTTPError{StatusCode: 429}); !got.Equal(at.Add(time.Minute)) {
		t.Fatal("success did not reset exponential backoff")
	}
}

func TestQuotaSyncCooldownPreservesStoredObservation(t *testing.T) {
	// A nil store deliberately fails any attempted database access: cooling
	// probes must return before loading credentials or overwriting quota data.
	application := &App{}
	now := time.Now()
	application.quotaBackoff.begin("credential", now)
	at := application.quotaBackoff.finish("credential", now, &gateway.QuotaHTTPError{StatusCode: 429})
	result := application.syncParentQuota(t.Context(), store.ParentSubscription{ID: "parent", UpstreamCredentialID: "credential"})
	if result.Status != "cooldown" || result.RetryAt == nil || !result.RetryAt.Equal(at) {
		t.Fatalf("cooldown result: %+v", result)
	}
}

func TestQuotaBackoffConcurrentProbes(t *testing.T) {
	var backoff quotaProbeBackoff
	var accepted atomic.Int32
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			if ok, _ := backoff.begin("shared", time.Now()); ok {
				accepted.Add(1)
			}
		})
	}
	workers.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("accepted %d concurrent probes", accepted.Load())
	}
	backoff.finish("shared", time.Now(), errors.New("HTTP 500"))
	if ok, _ := backoff.begin("shared", time.Now()); !ok {
		t.Fatal("non-429 failure left credential locked")
	}
}
