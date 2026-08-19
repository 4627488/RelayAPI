package app

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestLatencyTimelinePreservesCriticalPathAndNetworkSpans(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	timeline := newLatencyTimeline(started)
	timeline.Step(started.Add(2*time.Millisecond), "auth", "鉴权", "relay", "")
	timeline.Step(started.Add(7*time.Millisecond), "queue", "排队", "queue", "")
	timeline.Span(started.Add(3*time.Millisecond), started.Add(5*time.Millisecond), "tcp", "TCP", "upstream", "")
	timeline.Mark(started.Add(7*time.Millisecond), "first_byte", "首字节")

	var trace latencyTrace
	if err := json.Unmarshal([]byte(timeline.JSON(started.Add(9*time.Millisecond))), &trace); err != nil {
		t.Fatal(err)
	}
	if trace.Version != latencyTraceVersion || trace.TotalMS != 9 {
		t.Fatalf("trace header = version %d total %v", trace.Version, trace.TotalMS)
	}
	if len(trace.Segments) != 3 || trace.Segments[1].StartMS != 2 || trace.Segments[1].DurationMS != 5 {
		t.Fatalf("segments = %#v", trace.Segments)
	}
	if trace.Segments[2].Track != "network" || len(trace.Marks) != 1 || trace.Marks[0].OffsetMS != 7 {
		t.Fatalf("network/marks = %#v / %#v", trace.Segments[2], trace.Marks)
	}
}

func TestLatencyTimelineKeepsSubMillisecondPrecision(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	timeline := newLatencyTimeline(started)
	timeline.Step(started.Add(375*time.Microsecond), "auth", "鉴权", "relay", "")

	var trace latencyTrace
	if err := json.Unmarshal([]byte(timeline.JSON(started.Add(500*time.Microsecond))), &trace); err != nil {
		t.Fatal(err)
	}
	if trace.Segments[0].DurationMS != 0.375 || trace.TotalMS != 0.5 {
		t.Fatalf("sub-ms trace = %#v", trace)
	}
}

func TestLatencyTimelineAddsNativeRuntimeAttempts(t *testing.T) {
	started := time.Now()
	timeline := newLatencyTimeline(started)
	timeline.Step(started.Add(time.Millisecond), "prepare", "Prepare", "relay", "")
	timeline.AddUpstreamTrace(upstream.RequestTrace{
		RequestID: "request", StartedAt: started.Add(time.Millisecond), CompletedAt: started.Add(12 * time.Millisecond),
		Translation: "responses-to-chat",
		Attempts: []upstream.ExecutionAttempt{{
			Number: 1, Provider: "aliyun-bailian", Model: "qwen-plus", CredentialID: "bailian-a",
			StartedAt: started.Add(3 * time.Millisecond), CompletedAt: started.Add(10 * time.Millisecond), Status: "complete",
			GetConnAt: started.Add(3 * time.Millisecond), GotConnAt: started.Add(4 * time.Millisecond),
			RequestWrittenAt: started.Add(5 * time.Millisecond), FirstResponseAt: started.Add(8 * time.Millisecond),
		}},
	})
	var trace latencyTrace
	if err := json.Unmarshal([]byte(timeline.JSON(started.Add(13*time.Millisecond))), &trace); err != nil {
		t.Fatal(err)
	}
	if trace.Version != 3 {
		t.Fatalf("trace version = %d", trace.Version)
	}
	wantTracks := map[string]bool{"runtime": false, "attempt": false, "network": false}
	for _, segment := range trace.Segments {
		if _, exists := wantTracks[segment.Track]; exists {
			wantTracks[segment.Track] = true
		}
	}
	for track, found := range wantTracks {
		if !found {
			t.Fatalf("missing %s track in %#v", track, trace.Segments)
		}
	}
}
