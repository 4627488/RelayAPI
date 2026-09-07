package app

import (
	"strings"
	"testing"
	"time"
)

func TestFirstTokenSkipsMetadataAndHandlesSplitSSE(t *testing.T) {
	start := time.Now()
	var o firstTokenObserver
	o.Write([]byte("data: {\"type\":\"response.created\"}\n\n: ping\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n"), start)
	if !o.At.IsZero() {
		t.Fatal("metadata marked as first token")
	}
	o.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"he"), start.Add(time.Second))
	if !o.At.IsZero() {
		t.Fatal("partial event marked as first token")
	}
	o.Write([]byte("llo\"}\r\n\r\n"), start.Add(2*time.Second))
	if !o.At.Equal(start.Add(2 * time.Second)) {
		t.Fatalf("first token = %v", o.At)
	}
	o.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"later\"}\n\n"), start.Add(3*time.Second))
	if !o.At.Equal(start.Add(2 * time.Second)) {
		t.Fatal("first token was overwritten")
	}
}

func TestGeneratedDeltaKinds(t *testing.T) {
	for _, payload := range []string{
		`{"type":"response.reasoning_summary_text.delta","delta":"think"}`,
		`{"type":"response.function_call_arguments.delta","delta":"{"}`,
		`{"choices":[{"delta":{"content":"hello"}}]}`,
		`{"choices":[{"delta":{"reasoning_content":"think"}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{"}}]}}]}`,
	} {
		if !hasGeneratedDelta([]byte(payload)) {
			t.Errorf("missed generated delta: %s", payload)
		}
	}
	for _, payload := range []string{`{"type":"response.completed"}`, `{"type":"response.output_text.delta","delta":""}`, `[DONE]`, `{"choices":[{"delta":{"role":"assistant"}}]}`} {
		if hasGeneratedDelta([]byte(payload)) {
			t.Errorf("metadata became token: %s", payload)
		}
	}
}

func TestFirstTokenSkipsOversizedEventAndResumes(t *testing.T) {
	var o firstTokenObserver
	at := time.Now()
	o.Write([]byte("data: "+strings.Repeat("x", (1<<20)+1)+"\ndata: {\"choices\":[{\"delta\":{\"content\":\"not a new event\"}}]}\n\n"), at)
	if !o.At.IsZero() {
		t.Fatal("part of a dropped event became a token")
	}
	o.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"), at.Add(time.Second))
	if !o.At.Equal(at.Add(time.Second)) {
		t.Fatal("did not resume after dropped event")
	}
}

func TestWebSocketStepResetsFirstToken(t *testing.T) {
	a := nativeWebSocketAccounting{currentFirstToken: time.Now()}
	a.startStep(nativeWebSocketBillingEntry{StartedAt: time.Now()})
	if !a.currentFirstToken.IsZero() {
		t.Fatal("next step inherited the previous first token")
	}
}
