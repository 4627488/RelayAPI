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
	if trace.Version != 4 {
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

func TestLatencyTimelineAttributionSplitsUserRelayUpstream(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	timeline := newLatencyTimeline(started)
	timeline.Step(started.Add(4*time.Millisecond), "resolve_key", "解析 API Key", "relay", "")
	timeline.Step(started.Add(6*time.Millisecond), "read_request_body", "读取客户端请求", "downstream", "")
	timeline.Step(started.Add(9*time.Millisecond), "billing_admission", "订阅准入与预留", "billing", "")
	timeline.AddUpstreamTrace(upstream.RequestTrace{
		RequestID: "request", StartedAt: started.Add(9 * time.Millisecond), CompletedAt: started.Add(80 * time.Millisecond),
		Attempts: []upstream.ExecutionAttempt{{
			Number: 1, StartedAt: started.Add(11 * time.Millisecond), CompletedAt: started.Add(70 * time.Millisecond),
			GetConnAt: started.Add(11 * time.Millisecond), GotConnAt: started.Add(13 * time.Millisecond),
			RequestWrittenAt: started.Add(14 * time.Millisecond), FirstResponseAt: started.Add(40 * time.Millisecond),
			Status: "complete", Provider: "openai", Model: "gpt", CredentialID: "openai-a",
		}},
		Transfer: upstream.TraceTransfer{
			UpstreamReadWait: 25 * time.Millisecond,
			ClientWriteWait:  8 * time.Millisecond,
			FirstReadAt:      started.Add(40 * time.Millisecond),
			LastReadAt:       started.Add(70 * time.Millisecond),
			FirstWriteAt:     started.Add(41 * time.Millisecond),
			LastWriteAt:      started.Add(78 * time.Millisecond),
			BytesRead:        1200,
			BytesWritten:     1180,
			ReadCount:        6,
			WriteCount:       6,
		},
	})

	var trace latencyTrace
	if err := json.Unmarshal([]byte(timeline.JSON(started.Add(80*time.Millisecond))), &trace); err != nil {
		t.Fatal(err)
	}
	if trace.Version != 4 {
		t.Fatalf("version = %d", trace.Version)
	}
	if trace.Attribution.UserNetworkMS != 10 {
		t.Fatalf("user = %v want 10 (body 2 + write 8)", trace.Attribution.UserNetworkMS)
	}
	if trace.Attribution.RelayMS != 9 {
		t.Fatalf("relay = %v want 9 (resolve 4 + billing 3 + dispatch 2)", trace.Attribution.RelayMS)
	}
	if trace.Attribution.UpstreamMS != 54 {
		t.Fatalf("upstream = %v want 54 (conn 2 + write 1 + wait 26 + read 25)", trace.Attribution.UpstreamMS)
	}
	if trace.Attribution.Transfer == nil || trace.Attribution.Transfer.ReadCount != 6 || trace.Attribution.Transfer.BytesRead != 1200 {
		t.Fatalf("transfer = %#v", trace.Attribution.Transfer)
	}
	if trace.Attribution.ObservedSumMS != trace.Attribution.UserNetworkMS+trace.Attribution.RelayMS+trace.Attribution.UpstreamMS {
		t.Fatalf("observed sum = %#v", trace.Attribution)
	}
	var sawRead, sawWrite, sawAttempt bool
	for _, segment := range trace.Segments {
		switch segment.ID {
		case "upstream_read_wait":
			sawRead = segment.Bucket == bucketUpstream && segment.DurationMS == 25
		case "client_write_wait":
			sawWrite = segment.Bucket == bucketUser && segment.DurationMS == 8
		case "runtime_attempt_1":
			sawAttempt = segment.Bucket == ""
		}
	}
	if !sawRead || !sawWrite || !sawAttempt {
		t.Fatalf("transfer/attempt segments = %#v", trace.Segments)
	}
}
