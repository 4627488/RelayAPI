package upstream

import "testing"

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
