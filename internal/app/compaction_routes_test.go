package app

import (
	"errors"
	"strings"
	"testing"
)

func TestCompactionRoutingOnlyReadsProtocolItems(t *testing.T) {
	for _, body := range []string{
		`{"input":[{"type":"compaction","encrypted_content":"seal"}]}`,
		`{"input":[{"type":"compaction","encrypted_content":"seal"},{"type":"compaction","encrypted_content":"seal"}]}`,
	} {
		if got := compactionHashes([]byte(body), true); len(got) != 1 {
			t.Fatalf("hashes: %v", got)
		}
	}
	for _, body := range []string{
		`{"input":[{"role":"user","content":"compaction encrypted_content: seal"}]}`,
		`{"input":[{"type":"function_call_output","output":{"type":"compaction","encrypted_content":"seal"}}]}`,
	} {
		if len(compactionHashes([]byte(body), true)) != 0 {
			t.Fatal("user content influenced routing")
		}
	}
}

func TestCompactionObserverPersistsAcrossChunkBoundariesBeforeForwarding(t *testing.T) {
	for _, stream := range []bool{true, false} {
		payload := `{"output":[{"type":"compaction","encrypted_content":"opaque"}]}`
		if stream {
			payload = "event: response.output_item.done\r\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"encrypted_content\":\"opaque\"}}\r\n\r\n"
		}
		for split := 1; split < len(payload); split++ {
			calls := 0
			observer := newCompactionObserver(stream, 1<<20, func(event []byte) error {
				if len(compactionHashes(event, false)) > 0 {
					calls++
				}
				return nil
			})
			if err := observer.Write([]byte(payload[:split])); err != nil {
				t.Fatal(err)
			}
			if err := observer.Write([]byte(payload[split:])); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("stream=%v split=%d persisted=%d", stream, split, calls)
			}
		}
	}
	failed := errors.New("database unavailable")
	observer := newCompactionObserver(false, 1<<20, func([]byte) error { return failed })
	writer := &runtimeWriter{beforeWrite: observer.Write}
	if n, err := writer.Write([]byte(`{"output":[{"type":"compaction","encrypted_content":"seal"}]}`)); n != 0 || !errors.Is(err, failed) {
		t.Fatalf("undurable compaction was delivered: %d %v", n, err)
	}
	large := strings.Repeat("x", (1<<20)+1)
	calls := 0
	observer = newCompactionObserver(true, 2<<20, func(event []byte) error { calls += len(compactionHashes(event, false)); return nil })
	if err := observer.Write([]byte("data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"encrypted_content\":\"" + large + "\"}}\n\n")); err != nil || calls != 1 {
		t.Fatalf("large seal silently dropped: %d %v", calls, err)
	}
}
