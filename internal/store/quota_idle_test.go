package store

import (
	"encoding/json"
	"testing"
	"time"
)

func TestClaudeIdleWindowRequiresPostResetEvidence(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(-time.Hour)
	for _, test := range []struct {
		name          string
		source        string
		observed      time.Time
		used          any
		upstreamReset *time.Time
		enforceable   bool
		windowReset   time.Time
		want          bool
	}{
		{"confirmed idle", "claude-oauth-usage", now, 0, nil, false, reset, true},
		{"old snapshot", "claude-oauth-usage", reset.Add(-time.Second), 0, nil, false, reset, false},
		{"future observation", "claude-oauth-usage", now.Add(time.Minute), 0, nil, false, reset, false},
		{"still exhausted", "claude-oauth-usage", now, 100, nil, false, reset, false},
		{"missing utilization", "claude-oauth-usage", now, nil, nil, false, reset, false},
		{"another source", "codex-wham", now, 0, nil, false, reset, false},
		{"active upstream window", "claude-oauth-usage", now, 0, &now, false, reset, false},
		{"enforceable window", "claude-oauth-usage", now, 0, nil, true, reset, false},
		{"future local reset", "claude-oauth-usage", now, 0, nil, false, now.Add(time.Hour), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, _ := json.Marshal(map[string]any{"supported": true, "source": test.source, "observed_at": test.observed, "windows": []any{map[string]any{"kind": "5h", "used_percent": test.used, "resets_at": test.upstreamReset, "enforceable": test.enforceable}}})
			parent := ParentSubscription{QuotaSnapshot: snapshot, QuotaProbeStatus: "error"}
			window := ParentQuotaWindow{Kind: "5h", ResetsAt: test.windowReset}
			if got := claudeQuotaWindowIdle(parent, window, now); got != test.want {
				t.Fatalf("idle=%v want=%v", got, test.want)
			}
			window.Kind = "7d"
			if claudeQuotaWindowIdle(parent, window, now) {
				t.Fatal("weekly quota bypassed")
			}
		})
	}
}
