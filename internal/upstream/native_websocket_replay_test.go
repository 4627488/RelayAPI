package upstream

import (
	"strings"
	"testing"
)

func BenchmarkWebSocketTerminal(b *testing.B) {
	payload := []byte(`{"type":"response.output_text.delta","delta":"hello","response_id":"resp_test","output_index":0,"content_index":0}`)
	b.ReportAllocs()
	for b.Loop() {
		websocketTerminal(payload)
	}
}

func BenchmarkWebSocketModelLargeInput(b *testing.B) {
	payload := []byte(`{"type":"response.create","model":"gpt-test","input":[{"role":"user","content":"` + strings.Repeat("x", 256<<10) + `"}]}`)
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	for b.Loop() {
		websocketModel(payload)
	}
}

func TestWebSocketMetadataRejectsMalformedJSON(t *testing.T) {
	for _, payload := range []string{
		`{"type":"response.completed"`,
		`{"type":"response.completed"} trailing`,
		`{"type":"response.create","model":"gpt-test","input":[}`,
	} {
		if websocketTerminal([]byte(payload)) || websocketFullRequest([]byte(payload)) || websocketModel([]byte(payload)) != "" {
			t.Fatalf("accepted malformed JSON: %s", payload)
		}
	}
}

func TestWebSocketEOFReplayRequiresIndependentFullTurn(t *testing.T) {
	for _, tc := range []struct {
		payload string
		full    bool
	}{
		{`{"type":"response.create","input":[]}`, true},
		{`{"type":"response.create","input":"hello"}`, true},
		{`{"type":"response.create","input":[],"previous_response_id":"resp_previous"}`, false},
		{`{"type":"response.create"}`, false},
		{`{"type":"response.create","input":null}`, false},
		{`{"type":"session.update","input":[]}`, false},
	} {
		if got := websocketFullRequest([]byte(tc.payload)); got != tc.full {
			t.Fatalf("replay eligibility for %s: %v", tc.payload, got)
		}
	}
}

func TestWebSocketTerminalIncludesFailedAndIncompleteTurns(t *testing.T) {
	for _, event := range []string{"response.completed", "response.failed", "response.incomplete"} {
		if !websocketTerminal([]byte(`{"type":"` + event + `"}`)) {
			t.Fatalf("%s left the WebSocket turn open", event)
		}
	}
	if websocketTerminal([]byte(`{"type":"response.output_item.done"}`)) {
		t.Fatal("an output item ended the entire response")
	}
}
