package relaybridge

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func usageTestRecord(id, model string, input int64) usage.Record {
	return usage.Record{RequestID: id, Model: model, ResponseModel: model + "-served", ResponseServiceTier: "priority",
		Detail: usage.Detail{TokenBreakdown: usage.NewSubsetTokenBreakdown(input, input/2, 0, 4, 1, input+4)}}
}

func publishScope(scope *executionUsageScope, record usage.Record) {
	usage.PublishRecord(context.WithValue(context.Background(), executionUsageContextKey{}, scope), record)
}

func TestCPAUsageAsyncRetriesDedupAndCanonicalBuckets(t *testing.T) {
	r := &Runtime{traces: newRequestTraceRegistry()}
	failed := r.traces.usage.begin("request", "model(high)")
	bad := usageTestRecord("failed", "model", 100)
	bad.Failed = true
	publishScope(failed, bad)
	failed.finish(false)
	good := r.traces.usage.begin("request", "model(high)")
	good.observeEnvelope([]byte(`data: {"type":"response.completed","response":{"id":"resp_good"}}`))
	record := usageTestRecord("good", "model", 10)
	publishScope(good, record)
	publishScope(good, record)
	publishScope(good, usageTestRecord("good", "gpt-image-2", 500))
	good.finish(true)
	got, ok := r.RequestUsage(t.Context(), "request", "resp_good")
	if !ok || got.RequestID != "good" || got.InputTokens != 10 || got.CachedTokens != 5 || got.OutputTokens != 4 || got.ReasoningTokens != 1 || got.TotalTokens != 14 || got.ServiceTier != "priority" {
		t.Fatalf("got %#v, ok %v", got, ok)
	}
	gotHTTP, ok := r.RequestUsage(t.Context(), "request", "")
	if !ok || gotHTTP.RequestID != got.RequestID {
		t.Fatalf("HTTP selected wrong attempt: %#v", gotHTTP)
	}
}

func TestCPAUsageWebSocketTurnsAndDelayedPublication(t *testing.T) {
	r := &Runtime{traces: newRequestTraceRegistry()}
	first := r.traces.usage.begin("socket", "model")
	first.observeEnvelope([]byte(`{"response":{"id":"resp_first"}}`))
	publishScope(first, usageTestRecord("first", "model", 10))
	first.finish(true)
	second := r.traces.usage.begin("socket", "model")
	second.observeEnvelope([]byte(`{"response":{"id":"resp_second"}}`))
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(20 * time.Millisecond)
		publishScope(second, usageTestRecord("second", "model", 20))
		second.finish(true)
	}()
	got, ok := r.RequestUsage(t.Context(), "socket", "resp_second")
	if !ok || got.RequestID != "second" || got.InputTokens != 20 {
		t.Fatalf("second %#v, %v", got, ok)
	}
	got, ok = r.RequestUsage(t.Context(), "socket", "resp_first")
	if !ok || got.RequestID != "first" || got.InputTokens != 10 {
		t.Fatalf("first %#v, %v", got, ok)
	}
	<-done
}

func TestCPAUsageTerminalAvailableBeforeStreamDrain(t *testing.T) {
	r := &Runtime{traces: newRequestTraceRegistry()}
	scope := r.traces.usage.begin("socket", "model")
	// A valid pretty-printed terminal can be settled before any stream finish.
	scope.observeEnvelope([]byte("{\n  \"type\": \"response.completed\",\n  \"response\": {\"id\": \"resp_terminal\"}\n}"))
	publishScope(scope, usageTestRecord("terminal", "model", 10))
	got, ok := r.RequestUsage(t.Context(), "socket", "resp_terminal")
	if !ok || got.RequestID != "terminal" {
		t.Fatalf("terminal usage: %#v, %v", got, ok)
	}
	scope.finish(false) // Client disconnect after generation does not erase usage.
	if _, ok := r.RequestUsage(t.Context(), "socket", "resp_terminal"); !ok {
		t.Fatal("disconnect erased completed upstream usage")
	}
}

func TestCPAUsageConcurrentRequestsIsolated(t *testing.T) {
	r := &Runtime{traces: newRequestTraceRegistry()}
	var wg sync.WaitGroup
	for i := 1; i <= 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprint(i)
			scope := r.traces.usage.begin(id, "model")
			publishScope(scope, usageTestRecord(id, "model", int64(i)))
			scope.finish(true)
			got, ok := r.RequestUsage(t.Context(), id, "")
			if !ok || got.RequestID != id || got.InputTokens != int64(i) {
				t.Errorf("request %s got %#v", id, got)
			}
		}(i)
	}
	wg.Wait()
}

func TestCPAUsageZeroMissingPrewarmCancellationAndCleanup(t *testing.T) {
	for _, kind := range []string{"zero", "missing", "prewarm", "inconsistent"} {
		t.Run(kind, func(t *testing.T) {
			r := &Runtime{traces: newRequestTraceRegistry()}
			scope := r.traces.usage.begin("request", "model")
			record := usageTestRecord("id", "model", 0)
			switch kind {
			case "zero":
				record.Detail.TokenBreakdown = usage.NewSubsetTokenBreakdown(0, 0, 0, 0, 0, 0)
			case "missing":
				record.Detail = usage.Detail{}
			case "prewarm":
				record.Generate = usage.GenerateFlag(false)
			case "inconsistent":
				record.Detail.TokenBreakdown = usage.NewSubsetTokenBreakdown(1, 2, 0, 0, 0, 1)
			}
			publishScope(scope, record)
			scope.finish(true)
			got, ok := r.RequestUsage(t.Context(), "request", "")
			if ok != (kind == "zero") {
				t.Fatalf("%s got %#v, %v", kind, got, ok)
			}
			r.ReleaseRequestUsage("request")
			publishScope(scope, record)
			if _, ok := r.RequestUsage(t.Context(), "request", ""); ok {
				t.Fatal("released usage returned")
			}
			scope.store.mu.Lock()
			if len(scope.store.requests) != 0 {
				t.Error("usage leaked")
			}
			scope.store.mu.Unlock()
		})
	}
	r := &Runtime{traces: newRequestTraceRegistry()}
	r.traces.usage.begin("pending", "model")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	started := time.Now()
	if _, ok := r.RequestUsage(ctx, "pending", ""); ok || time.Since(started) > 100*time.Millisecond {
		t.Fatal("cancellation not honored")
	}
}

type usageTestExecutor struct {
	coreauth.ProviderExecutor
	err error
}

func (*usageTestExecutor) Identifier() string { return "test" }
func (e *usageTestExecutor) Execute(ctx context.Context, _ *coreauth.Auth, req executor.Request, _ executor.Options) (executor.Response, error) {
	usage.PublishRecord(ctx, usageTestRecord("executor", req.Model, 10))
	return executor.Response{Payload: []byte(`{"id":"resp_executor"}`)}, e.err
}

func TestObservedExecutorPassesScopeIntoCPAUsage(t *testing.T) {
	for _, failed := range []bool{false, true} {
		r := &Runtime{traces: newRequestTraceRegistry()}
		inner := &usageTestExecutor{}
		if failed {
			inner.err = errors.New("failed execution")
		}
		exec := observeExecutor(inner, r.traces)
		_, err := exec.Execute(t.Context(), nil, executor.Request{Model: "model"}, executor.Options{Headers: http.Header{"X-Relay-Request-Id": []string{"relay"}}})
		if (err != nil) != failed {
			t.Fatal(err)
		}
		got, ok := r.RequestUsage(t.Context(), "relay", "resp_executor")
		if ok == failed || (!failed && got.RequestID != "executor") {
			t.Fatalf("failed=%v result=%#v ok=%v", failed, got, ok)
		}
	}
}
