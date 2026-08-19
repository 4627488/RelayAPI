package cpa

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionBoundsInFlightWithoutBufferingAQueue(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{
		MaxInFlight: 1, QueueTimeout: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Acquire(t.Context(), 1); !errors.Is(err, ErrOverloaded) {
		t.Fatalf("second Acquire() error = %v, want ErrOverloaded", err)
	}
	if status := client.AdmissionStatus(); status.InFlight != 1 || status.MaxInFlight != 1 || status.Rejected != 1 {
		t.Fatalf("admission status = %+v", status)
	}
	lease.Release()
	lease, err = client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
}

func TestControlPlaneHasDedicatedConnectionPool(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{MaxInFlight: 7})
	if err != nil {
		t.Fatal(err)
	}
	dataTransport, dataOK := client.HTTP.Transport.(*http.Transport)
	controlTransport, controlOK := client.ControlHTTP.Transport.(*http.Transport)
	if !dataOK || !controlOK || dataTransport == controlTransport {
		t.Fatal("data and control planes do not have distinct HTTP transports")
	}
	if dataTransport.MaxConnsPerHost != 7 || controlTransport.MaxConnsPerHost != 4 {
		t.Fatalf("data/control max connections = %d/%d", dataTransport.MaxConnsPerHost, controlTransport.MaxConnsPerHost)
	}
}

func TestAdmissionBoundsRequestBodyBytes(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{
		MaxInFlight: 2, MaxRequestBytesInFlight: 10, QueueTimeout: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := client.Acquire(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Acquire(t.Context(), 1); !errors.Is(err, ErrOverloaded) {
		t.Fatalf("Acquire() beyond body budget = %v, want ErrOverloaded", err)
	}
	if status := client.AdmissionStatus(); status.RequestBytes != 10 || status.MaxRequestBytes != 10 {
		t.Fatalf("body admission status = %+v", status)
	}
	lease.Release()
}

func TestAdmissionBoundsWaitingQueue(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{
		MaxInFlight: 1, MaxQueue: 1, QueueTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	active, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	waiting := make(chan *Lease, 1)
	waitingErr := make(chan error, 1)
	go func() {
		lease, acquireErr := client.Acquire(t.Context(), 1)
		if acquireErr != nil {
			waitingErr <- acquireErr
			return
		}
		waiting <- lease
	}()
	deadline := time.Now().Add(time.Second)
	for client.AdmissionStatus().QueueDepth != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if status := client.AdmissionStatus(); status.QueueDepth != 1 || status.MaxQueue != 1 {
		t.Fatalf("queue status = %+v", status)
	}
	if _, err := client.Acquire(t.Context(), 1); !errors.Is(err, ErrOverloaded) {
		t.Fatalf("Acquire() beyond queue = %v, want ErrOverloaded", err)
	}
	active.Release()
	select {
	case lease := <-waiting:
		lease.Release()
	case err := <-waitingErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("queued acquisition did not resume")
	}
}

func TestAdmissionLoadSheddingRemainsBoundedUnderBurst(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{
		MaxInFlight: 4, MaxQueue: 8, MaxRequestBytesInFlight: 16,
		QueueTimeout: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var accepted atomic.Int64
	start := make(chan struct{})
	for range 1_000 {
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
	if accepted.Load() == 0 || status.Rejected == 0 {
		t.Fatalf("burst accepted/rejected = %d/%d", accepted.Load(), status.Rejected)
	}
	if status.InFlight != 0 || status.QueueDepth != 0 || status.RequestBytes != 0 {
		t.Fatalf("admission resources leaked after burst: %+v", status)
	}
}

func TestCircuitBreakerAllowsOneRecoveryProbe(t *testing.T) {
	client, err := NewWithOptions("http://cpa.test", "api", Options{
		MaxInFlight: 2, QueueTimeout: 0, CircuitFailureThreshold: 2, CircuitOpenDuration: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	client.RecordTransportResult(errors.New("connection reset"))
	client.RecordTransportResult(errors.New("connection refused"))
	if _, err := client.Acquire(t.Context(), 1); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("Acquire() error = %v, want ErrCircuitOpen", err)
	}
	time.Sleep(15 * time.Millisecond)
	probe, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Acquire(t.Context(), 1); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("parallel recovery Acquire() error = %v, want ErrCircuitOpen", err)
	}
	client.RecordTransportResult(nil)
	probe.Release()
	lease, err := client.Acquire(t.Context(), 1)
	if err != nil {
		t.Fatalf("Acquire() after recovery = %v", err)
	}
	lease.Release()
}

func TestResponseHeaderTimeoutDoesNotLimitStreamingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(30 * time.Millisecond)
		_, _ = io.WriteString(w, "done")
	}))
	defer server.Close()
	client, err := NewWithOptions(server.URL, "api", Options{ResponseHeaderTimeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.HTTP.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil || string(payload) != "done" {
		t.Fatalf("stream payload/error = %q/%v", payload, err)
	}
}
