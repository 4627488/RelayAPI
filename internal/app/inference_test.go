package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRuntimeWriterForwardsSuccessAndErrors(t *testing.T) {
	success := httptest.NewRecorder()
	out := &runtimeWriter{client: success, stream: true, capture: &rollingCapture{max: 64}}
	out.Header().Set("Content-Type", "text/event-stream")
	out.WriteHeader(http.StatusOK)
	if _, err := out.Write([]byte("data: ok\n\n")); err != nil {
		t.Fatal(err)
	}
	if success.Code != http.StatusOK || success.Body.String() != "data: ok\n\n" {
		t.Fatalf("streamed = %d %q", success.Code, success.Body.String())
	}

	errorClient := httptest.NewRecorder()
	failed := &runtimeWriter{client: errorClient, capture: &rollingCapture{max: 64}}
	failed.Header().Set("Content-Type", "application/json")
	failed.WriteHeader(http.StatusTooManyRequests)
	if _, err := failed.Write([]byte(`{"error":"busy"}`)); err != nil {
		t.Fatal(err)
	}
	if errorClient.Code != http.StatusTooManyRequests || errorClient.Body.String() != `{"error":"busy"}` {
		t.Fatalf("forwarded error = %d %q", errorClient.Code, errorClient.Body.String())
	}
	detail, _, _ := failed.capture.Info()
	if string(detail) != `{"error":"busy"}` {
		t.Fatalf("captured error = %q", detail)
	}
}

func TestRollingCaptureKeepsDetailPrefixAndBillingTail(t *testing.T) {
	capture := &rollingCapture{max: 5}
	for _, chunk := range []string{"abc", "def", "gh"} {
		if written, err := capture.Write([]byte(chunk)); err != nil || written != len(chunk) {
			t.Fatalf("write %q = %d, %v", chunk, written, err)
		}
	}
	if tail := string(capture.Bytes()); tail != "defgh" {
		t.Fatalf("billing tail = %q, want defgh", tail)
	}
	detail, truncated, total := capture.Info()
	if string(detail) != "abcdefgh" || truncated || total != 8 {
		t.Fatalf("detail = %q, truncated = %v, total = %d", detail, truncated, total)
	}
}

func BenchmarkRollingCaptureLongStream(b *testing.B) {
	chunk := bytes.Repeat([]byte("x"), 32<<10)
	b.SetBytes(int64(len(chunk) * 256))
	b.ReportAllocs()
	for range b.N {
		capture := &rollingCapture{max: 2 << 20}
		for range 256 {
			_, _ = capture.Write(chunk)
		}
		_ = capture.Bytes()
	}
}

func TestSetStreamingHeadersDisablesTransformBuffering(t *testing.T) {
	header := make(http.Header)
	setStreamingHeaders(header, true)
	if header.Get("Cache-Control") != "no-cache, no-transform" || header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("streaming headers = %#v", header)
	}
}

func TestCopyHeadersDropsInternalRelayHeaders(t *testing.T) {
	source := http.Header{
		"Content-Type":             {"application/json"},
		"X-Relay-Cpa-Auth-Id":      {"attacker-selected-auth"},
		"X-Relay-Plugin-Secret":    {"attacker-secret"},
		"X-Relay-Arbitrary-Future": {"must-not-pass"},
	}
	destination := make(http.Header)
	copyHeaders(destination, source)
	if got := destination.Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	for name := range source {
		if name != "Content-Type" && destination.Get(name) != "" {
			t.Fatalf("internal header %s was forwarded", name)
		}
	}
}

func TestPrepareRuntimeHeadersPinsCPAAndUpstreamCredential(t *testing.T) {
	header := http.Header{
		"Authorization":       {"Bearer client-key"},
		"X-Relay-Cpa-Auth-Id": {"attacker-selected-auth"},
	}
	prepareRuntimeHeaders(header, "req-1", "cred-9")
	if header.Get("Authorization") != "" {
		t.Fatal("client authorization must be stripped before the in-process CPA call")
	}
	if header.Get("X-Relay-Request-ID") != "req-1" {
		t.Fatalf("request id = %q", header.Get("X-Relay-Request-ID"))
	}
	if header.Get("X-Relay-Upstream-Credential-ID") != "cred-9" {
		t.Fatalf("upstream credential = %q", header.Get("X-Relay-Upstream-Credential-ID"))
	}
	if header.Get("X-Relay-CPA-Auth-ID") != "cred-9" {
		t.Fatalf("cpa auth = %q", header.Get("X-Relay-CPA-Auth-ID"))
	}
}

func TestStripRelayHeaders(t *testing.T) {
	header := http.Header{
		"X-Relay-Cpa-Auth-Id":   {"attacker-selected-auth"},
		"X-Relay-Plugin-Secret": {"attacker-secret"},
		"X-Api-Key":             {"public-key"},
	}
	stripRelayHeaders(header)
	if header.Get("X-Relay-Cpa-Auth-Id") != "" || header.Get("X-Relay-Plugin-Secret") != "" {
		t.Fatal("internal Relay headers were not stripped")
	}
	if header.Get("X-Api-Key") != "public-key" {
		t.Fatal("non-Relay headers must be preserved")
	}
}
