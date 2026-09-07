package relaybridge

import (
	"errors"
	"net/http/httptrace"
	"testing"
	"time"
)

func TestRequestTraceRegistryCapturesAttemptsAndConsumesTrace(t *testing.T) {
	registry := newRequestTraceRegistry()
	started := time.Now()
	registry.begin("request", started)
	number := registry.startAttempt("request", "stream", "codex", "gpt-test", "credential", started.Add(time.Millisecond))
	registry.updateAttempt("request", number, func(attempt *ExecutionAttempt) {
		attempt.HeadersAt = started.Add(2 * time.Millisecond)
		attempt.FirstChunkAt = started.Add(3 * time.Millisecond)
		attempt.CompletedAt = started.Add(4 * time.Millisecond)
		attempt.Status = "complete"
	})
	registry.complete("request", started.Add(5*time.Millisecond))

	trace, ok := registry.take("request")
	if !ok || trace.RequestID != "request" || len(trace.Attempts) != 1 {
		t.Fatalf("trace = %#v, ok = %v", trace, ok)
	}
	if trace.Attempts[0].Number != 1 || trace.Attempts[0].Provider != "codex" || trace.CompletedAt.IsZero() {
		t.Fatalf("attempt = %#v", trace.Attempts[0])
	}
	registry.begin("snapshot", started)
	if snapshot, exists := registry.snapshot("snapshot"); !exists || snapshot.RequestID != "snapshot" {
		t.Fatalf("snapshot = %#v, exists = %v", snapshot, exists)
	}
	if _, exists := registry.snapshot("snapshot"); !exists {
		t.Fatal("snapshot consumed the trace")
	}
	if _, exists := registry.take("request"); exists {
		t.Fatal("trace was not consumed")
	}
}

func TestNetworkTraceDoesNotCombineTransportReplays(t *testing.T) {
	state := &attemptHTTPTrace{}
	trace := state.clientTrace()
	trace.GetConn("first")
	trace.GotConn(httptrace.GotConnInfo{})
	trace.WroteRequest(httptrace.WroteRequestInfo{Err: errors.New("write failed")})
	if !state.snapshot().wroteRequest.IsZero() {
		t.Fatal("failed write reported complete")
	}
	trace.GetConn("retry")
	trace.GotConn(httptrace.GotConnInfo{})
	trace.WroteRequest(httptrace.WroteRequestInfo{})
	trace.GotFirstResponseByte()
	got := state.snapshot()
	if !got.getConn.IsZero() || !got.wroteRequest.IsZero() || !got.firstResponseByte.IsZero() {
		t.Fatal("mixed timing pairs across transport replays")
	}
}
