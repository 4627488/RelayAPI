package gateway

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionBoundsConcurrencyQueueAndBodyMemory(t *testing.T) {
	client, err := NewWithOptions("http://runtime.test", "key", Options{MaxInFlight: 1, MaxQueue: 1, MaxRequestBytesInFlight: 10, QueueTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	active, err := client.Acquire(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	waiting := make(chan *Lease, 1)
	go func() { lease, _ := client.Acquire(t.Context(), 1); waiting <- lease }()
	deadline := time.Now().Add(time.Second)
	for client.AdmissionStatus().QueueDepth != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, err = client.Acquire(t.Context(), 1); !errors.Is(err, ErrOverloaded) {
		t.Fatalf("overload error = %v", err)
	}
	status := client.AdmissionStatus()
	if status.InFlight != 1 || status.QueueDepth != 1 || status.RequestBytes != 10 || status.Rejected != 1 {
		t.Fatalf("status = %+v", status)
	}
	active.Release()
	select {
	case lease := <-waiting:
		lease.Release()
	case <-time.After(time.Second):
		t.Fatal("queued request did not resume")
	}
}

func TestAdmissionLoadSheddingReleasesAllResources(t *testing.T) {
	client, err := NewWithOptions("http://runtime.test", "key", Options{MaxInFlight: 4, MaxQueue: 8, MaxRequestBytesInFlight: 16, QueueTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var accepted atomic.Int64
	start := make(chan struct{})
	for range 250 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			lease, acquireErr := client.Acquire(t.Context(), 4)
			if acquireErr != nil {
				return
			}
			accepted.Add(1)
			time.Sleep(time.Millisecond)
			lease.Release()
		}()
	}
	close(start)
	workers.Wait()
	status := client.AdmissionStatus()
	if accepted.Load() == 0 || status.Rejected == 0 || status.InFlight != 0 || status.QueueDepth != 0 || status.RequestBytes != 0 {
		t.Fatalf("accepted=%d status=%+v", accepted.Load(), status)
	}
}

func TestCircuitBreakerAllowsSingleRecoveryProbe(t *testing.T) {
	client, err := NewWithOptions("http://runtime.test", "key", Options{MaxInFlight: 2, CircuitFailureThreshold: 2, CircuitOpenDuration: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	client.RecordTransportResult(errors.New("reset"))
	client.RecordTransportResult(errors.New("refused"))
	if _, err = client.Acquire(t.Context(), 1); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("open error = %v", err)
	}
	time.Sleep(15 * time.Millisecond)
	probe, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Acquire(t.Context(), 1); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("parallel probe error = %v", err)
	}
	client.RecordTransportResult(nil)
	probe.Release()
	lease, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
}
