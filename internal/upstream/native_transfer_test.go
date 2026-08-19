package upstream

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type delayReader struct {
	data  []byte
	delay time.Duration
}

func (r *delayReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	time.Sleep(r.delay)
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

type delayWriter struct {
	delay time.Duration
}

func (w *delayWriter) Write(p []byte) (int, error) {
	time.Sleep(w.delay)
	return len(p), nil
}

func TestTransferClockSplitsReadAndWriteWaits(t *testing.T) {
	clock := newTransferClock()
	reader := clock.reader(&delayReader{data: []byte("abcdef"), delay: 15 * time.Millisecond})
	writer := clock.writer(&delayWriter{delay: 10 * time.Millisecond})
	if _, err := io.Copy(writer, reader); err != nil {
		t.Fatal(err)
	}
	var trace RequestTrace
	clock.apply(&trace)
	if trace.Transfer.BytesRead != 6 || trace.Transfer.BytesWritten != 6 {
		t.Fatalf("bytes = %+v", trace.Transfer)
	}
	if trace.Transfer.ReadCount == 0 || trace.Transfer.WriteCount == 0 {
		t.Fatalf("counts = %+v", trace.Transfer)
	}
	if trace.Transfer.UpstreamReadWait < 15*time.Millisecond {
		t.Fatalf("read wait = %v", trace.Transfer.UpstreamReadWait)
	}
	if trace.Transfer.ClientWriteWait < 10*time.Millisecond {
		t.Fatalf("write wait = %v", trace.Transfer.ClientWriteWait)
	}
	if trace.Transfer.FirstReadAt.IsZero() || trace.Transfer.FirstWriteAt.IsZero() {
		t.Fatalf("missing first timestamps: %+v", trace.Transfer)
	}
}

func TestRuntimeTraceRecordsBodyReadAndWrite(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(20 * time.Millisecond)
		_, _ = io.WriteString(w, `{"id":"resp_ok","output":[]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer runtime-test-key")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Relay-Request-ID", "transfer-1")
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	trace, ok := runtime.TakeRequestTrace("transfer-1")
	if !ok {
		t.Fatal("missing trace")
	}
	if trace.Transfer.BytesRead == 0 || trace.Transfer.WriteCount == 0 || trace.Transfer.BytesWritten == 0 {
		t.Fatalf("transfer = %+v", trace.Transfer)
	}
	if trace.Transfer.UpstreamReadWait < 15*time.Millisecond {
		t.Fatalf("read wait = %v", trace.Transfer.UpstreamReadWait)
	}
}
