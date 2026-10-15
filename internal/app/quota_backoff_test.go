package app

import (
	"context"
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
	for _, delay := range []time.Duration{5 * time.Minute, 10 * time.Minute, 20 * time.Minute, 40 * time.Minute, time.Hour, time.Hour} {
		if ok, _ := backoff.begin("claude", now); !ok {
			t.Fatal("due probe blocked")
		}
		err := fmt.Errorf("Claude quota request: %w", &gateway.QuotaHTTPError{StatusCode: http.StatusTooManyRequests})
		at := backoff.finish("claude", now, err, "claude")
		if at.Before(now.Add(delay)) || at.After(now.Add(delay+delay/5)) {
			t.Fatalf("delay=%s want %s plus jitter", at.Sub(now), delay)
		}
		if ok, _ := backoff.begin("claude", at.Add(-time.Nanosecond)); ok {
			t.Fatal("probe ignored cooldown")
		}
		if ok, _ := backoff.begin("codex", now); !ok {
			t.Fatal("different credential affected")
		}
		backoff.finish("codex", now, nil, "codex")
		now = at
	}
	backoff.begin("claude", now)
	backoff.finish("claude", now, nil, "claude")
	backoff.begin("claude", now)
	later := now.Add(3 * time.Hour)
	at := backoff.finish("claude", now, &gateway.QuotaHTTPError{StatusCode: 429, RetryAt: later}, "claude")
	if !at.Equal(later) {
		t.Fatal("upstream Retry-After ignored")
	}
	backoff.begin("claude", at)
	backoff.finish("claude", at, nil, "claude")
	backoff.begin("claude", at)
	if next := backoff.finish("claude", at, &gateway.QuotaHTTPError{StatusCode: 429}, "claude"); next.After(at.Add(6 * time.Minute)) {
		t.Fatal("success did not reset backoff")
	}
}

func TestQuotaSyncCooldownPreservesStoredObservation(t *testing.T) {
	// Nil store: any database access here would panic. Cooling queries must not
	// load credentials or overwrite the last successful snapshot.
	application := &App{}
	now := time.Now()
	application.quotaBackoff.begin("credential", now)
	at := application.quotaBackoff.finish("credential", now, &gateway.QuotaHTTPError{StatusCode: 429}, "claude")
	result := application.syncParentQuota(t.Context(), store.ParentSubscription{ID: "parent", UpstreamCredentialID: "credential", Provider: "claude"})
	if result.Status != "cooldown" || result.RetryAt == nil || !result.RetryAt.Equal(at) {
		t.Fatalf("result=%+v", result)
	}
}

func TestQuotaSyncReusesDurableClaudeSnapshot(t *testing.T) {
	application := &App{}
	observed := time.Now().Add(-time.Minute)
	result := application.syncParentQuota(t.Context(), store.ParentSubscription{ID: "parent", Provider: "claude", QuotaSupported: true, QuotaObservedAt: &observed})
	if result.Status != "cached" || !result.Supported || result.RetryAt == nil || !result.RetryAt.Equal(observed.Add(5*time.Minute)) {
		t.Fatalf("result=%+v", result)
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
	now := time.Now()
	at := backoff.finish("shared", now, errors.New("HTTP 500"), "codex")
	if at.Before(now.Add(time.Minute)) {
		t.Fatal("non-429 failure was not backed off")
	}
	if ok, _ := backoff.begin("shared", at); !ok {
		t.Fatal("probe did not resume at deadline")
	}
	backoff.finish("shared", at, context.Canceled, "codex")
	if ok, _ := backoff.begin("shared", at); !ok {
		t.Fatal("canceled request kept credential locked")
	}
}
