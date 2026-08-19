package gateway

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/semaphore"
)

var (
	ErrOverloaded  = errors.New("Upstream admission queue is full")
	ErrCircuitOpen = errors.New("Upstream circuit breaker is open")
)

type AdmissionStatus struct {
	InFlight           int    `json:"in_flight"`
	MaxInFlight        int    `json:"max_in_flight"`
	QueueDepth         int    `json:"queue_depth"`
	MaxQueue           int    `json:"max_queue"`
	RequestBytes       int64  `json:"request_bytes_in_flight"`
	MaxRequestBytes    int64  `json:"max_request_bytes_in_flight"`
	Rejected           uint64 `json:"rejected"`
	ConsecutiveFailure int    `json:"consecutive_failures"`
	Circuit            string `json:"circuit"`
	RetryAfterMS       int64  `json:"retry_after_ms,omitempty"`
}

type admissionController struct {
	slots            chan struct{}
	waiters          chan struct{}
	body             *semaphore.Weighted
	bodyLimit        int64
	bodyInFlight     atomic.Int64
	queueTimeout     time.Duration
	failureThreshold int
	openDuration     time.Duration
	rejected         atomic.Uint64

	mu                  sync.Mutex
	consecutiveFailures int
	openUntil           time.Time
	probeActive         bool
}

type Lease struct {
	controller *admissionController
	probe      bool
	bodyWeight int64
	once       sync.Once
}

func newAdmissionController(maxInFlight, maxQueue int, maxRequestBytes int64, queueTimeout time.Duration, failureThreshold int, openDuration time.Duration) *admissionController {
	return &admissionController{
		slots: make(chan struct{}, maxInFlight), waiters: make(chan struct{}, maxQueue),
		body: semaphore.NewWeighted(maxRequestBytes), bodyLimit: maxRequestBytes, queueTimeout: queueTimeout,
		failureThreshold: failureThreshold, openDuration: openDuration,
	}
}

func (c *Client) Acquire(ctx context.Context, expectedBodyBytes int64) (*Lease, error) {
	return c.admission.acquire(ctx, expectedBodyBytes)
}

func (c *Client) AdmissionStatus() AdmissionStatus {
	return c.admission.status(time.Now())
}

func (c *Client) RecordOutcome(err error) {
	c.admission.recordOutcome(err)
}

func (a *admissionController) acquire(ctx context.Context, expectedBodyBytes int64) (*Lease, error) {
	probe, err := a.allow(time.Now())
	if err != nil {
		a.rejected.Add(1)
		return nil, err
	}
	waitCtx := ctx
	cancelWait := func() {}
	if a.queueTimeout > 0 {
		waitCtx, cancelWait = context.WithTimeout(ctx, a.queueTimeout)
	}
	defer cancelWait()

	acquired := false
	select {
	case a.slots <- struct{}{}:
		acquired = true
	default:
	}
	if !acquired && a.queueTimeout > 0 && cap(a.waiters) > 0 {
		select {
		case a.waiters <- struct{}{}:
			defer func() { <-a.waiters }()
		default:
			a.cancelProbe(probe)
			a.rejected.Add(1)
			return nil, ErrOverloaded
		}
		select {
		case a.slots <- struct{}{}:
			acquired = true
		case <-waitCtx.Done():
			a.cancelProbe(probe)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			a.rejected.Add(1)
			return nil, ErrOverloaded
		}
	}
	if !acquired {
		a.cancelProbe(probe)
		a.rejected.Add(1)
		return nil, ErrOverloaded
	}
	bodyWeight := expectedBodyBytes
	if bodyWeight < 1 {
		bodyWeight = 1
	}
	if bodyWeight > a.bodyLimit {
		bodyWeight = a.bodyLimit
	}
	if !a.body.TryAcquire(bodyWeight) {
		if a.queueTimeout == 0 {
			<-a.slots
			a.cancelProbe(probe)
			a.rejected.Add(1)
			return nil, ErrOverloaded
		}
		err = a.body.Acquire(waitCtx, bodyWeight)
		if err != nil {
			<-a.slots
			a.cancelProbe(probe)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			a.rejected.Add(1)
			return nil, ErrOverloaded
		}
	}
	a.bodyInFlight.Add(bodyWeight)
	return &Lease{controller: a, probe: probe, bodyWeight: bodyWeight}, nil
}

func (l *Lease) Release() {
	if l == nil || l.controller == nil {
		return
	}
	l.once.Do(func() {
		l.controller.body.Release(l.bodyWeight)
		l.controller.bodyInFlight.Add(-l.bodyWeight)
		<-l.controller.slots
		l.controller.cancelProbe(l.probe)
	})
}

func (a *admissionController) allow(now time.Time) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.openUntil.After(now) {
		return false, ErrCircuitOpen
	}
	if !a.openUntil.IsZero() {
		if a.probeActive {
			return false, ErrCircuitOpen
		}
		a.probeActive = true
		return true, nil
	}
	return false, nil
}

func (a *admissionController) cancelProbe(probe bool) {
	if !probe {
		return
	}
	a.mu.Lock()
	a.probeActive = false
	a.mu.Unlock()
}

func (a *admissionController) recordOutcome(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.probeActive = false
	if err == nil {
		a.consecutiveFailures = 0
		a.openUntil = time.Time{}
		return
	}
	a.consecutiveFailures++
	if a.consecutiveFailures >= a.failureThreshold {
		a.openUntil = time.Now().Add(a.openDuration)
	}
}

func (a *admissionController) status(now time.Time) AdmissionStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	status := AdmissionStatus{
		InFlight: len(a.slots), MaxInFlight: cap(a.slots), Rejected: a.rejected.Load(),
		QueueDepth: len(a.waiters), MaxQueue: cap(a.waiters), RequestBytes: a.bodyInFlight.Load(), MaxRequestBytes: a.bodyLimit,
		ConsecutiveFailure: a.consecutiveFailures, Circuit: "closed",
	}
	if a.openUntil.After(now) {
		status.Circuit = "open"
		status.RetryAfterMS = a.openUntil.Sub(now).Milliseconds()
	} else if !a.openUntil.IsZero() {
		status.Circuit = "half_open"
	}
	return status
}
