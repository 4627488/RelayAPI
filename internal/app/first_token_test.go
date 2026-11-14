package app

import (
	"strings"
	"testing"
	"time"
)

func BenchmarkGeneratedResponsesDelta(b *testing.B) {
	payload := []byte(`{"type":"response.output_text.delta","delta":"hello","response_id":"resp_test","output_index":0,"content_index":0}`)
	b.ReportAllocs()
	for b.Loop() {
		generatedContent(payload)
	}
}

func TestGeneratedResponsesDeltaRejectsInvalidJSONAndNonStringDelta(t *testing.T) {
	for _, payload := range []string{
		`{"type":"response.output_text.delta","delta":"hello"`,
		`{"type":"response.output_text.delta","delta":42}`,
		`{"type":"response.completed","response":{"output":[{"content":[{"text":"already generated"}]}]}}`,
	} {
		if hasGeneratedDelta([]byte(payload)) {
			t.Fatalf("invalid or non-delta envelope became generated content: %s", payload)
		}
	}
}

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
		`{"type":"response.custom_tool_call_input.delta","delta":"*** Begin Patch"}`,
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

func TestStreamKeepsCacheUsageBeyondDiagnosticCaptureAndTimesText(t *testing.T) {
	started := time.Now()
	o := &firstTokenObserver{}
	o.Write([]byte("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":0,\"cache_read_input_tokens\":30,\"cache_creation_input_tokens\":20,\"cache_creation\":{\"ephemeral_1h_input_tokens\":15}}}}\n\n"), started)
	o.Write([]byte("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"think\"}}\n\n"), started.Add(time.Second))
	o.Write([]byte("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\n"), started.Add(2*time.Second))
	o.Write([]byte("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":50}}\n\n"), started.Add(3*time.Second))
	if o.At != started.Add(time.Second) || o.TextAt != started.Add(2*time.Second) || o.Usage.Usage.Input != 10 || o.Usage.Usage.CacheRead != 30 || o.Usage.Usage.CacheWrite1h != 15 || o.Usage.Usage.Total != 60 {
		t.Fatalf("stream lost accounting/first content: %+v", o)
	}
}
