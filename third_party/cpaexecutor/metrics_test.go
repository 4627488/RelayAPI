package relaybridge

import (
	"context"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestExecutionObservationWithoutRequestIDAndFinishOnce(t *testing.T) {
	registry := newRequestTraceRegistry()
	var observed []ExecutionAttempt
	registry.onExecution = func(attempt ExecutionAttempt) { observed = append(observed, attempt) }
	e := observeExecutor(&usageTestExecutor{}, registry).(*observedExecutor)
	state, _ := e.begin(context.Background(), nil, executor.Request{Model: "m"}, executor.Options{}, "stream")
	state.headers(time.Now())
	state.firstChunk(time.Now())
	state.finish(context.Canceled, "canceled")
	state.finish(nil, "complete")
	if len(observed) != 1 || observed[0].Error != "request_canceled" || observed[0].FirstChunkAt.IsZero() || observed[0].CompletedAt.Before(observed[0].StartedAt) {
		t.Fatalf("unexpected observations: %#v", observed)
	}
	if !observed[0].RequestWrittenAt.IsZero() {
		t.Fatal("fabricated HTTP transport timing")
	}
}

func TestCredentialHealthAggregatesSchedulerState(t *testing.T) {
	r := &Runtime{manager: coreauth.NewManager(nil, nil, nil), credentials: []Credential{{ID: "a", Provider: "codex", Enabled: true}, {ID: "b", Provider: "codex"}}}
	_, err := r.manager.Register(context.Background(), &coreauth.Auth{ID: "a", Provider: "codex", Unavailable: true, NextRetryAfter: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	groups := r.CredentialHealthSnapshot()
	if len(groups) != 1 || groups[0].Enabled != 1 || groups[0].Disabled != 1 || groups[0].Unavailable != 1 || groups[0].Cooling != 1 {
		t.Fatalf("unexpected snapshot: %#v", groups)
	}
}
