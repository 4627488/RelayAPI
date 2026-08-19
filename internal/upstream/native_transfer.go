package upstream

import (
	"io"
	"net/http"
	"sync"
	"time"
)

// TraceTransfer is the Relay-observable cost of copying the provider body
// to the client. Read and write waits are accumulated separately; they
// alternate on a single Copy loop, so their sum can match or slightly
// exceed the transfer wall clock.
type TraceTransfer struct {
	UpstreamReadWait time.Duration
	ClientWriteWait  time.Duration
	FirstReadAt      time.Time
	LastReadAt       time.Time
	FirstWriteAt     time.Time
	LastWriteAt      time.Time
	BytesRead        int64
	BytesWritten     int64
	ReadCount        int
	WriteCount       int
}

type transferClock struct {
	mu sync.Mutex
	TraceTransfer
}

func newTransferClock() *transferClock {
	return &transferClock{}
}

func (c *transferClock) reader(r io.Reader) io.Reader {
	if c == nil || r == nil {
		return r
	}
	return timedReader{r: r, clock: c}
}

func (c *transferClock) writer(w io.Writer) io.Writer {
	if c == nil || w == nil {
		return w
	}
	return timedWriter{w: w, clock: c}
}

func (c *transferClock) apply(trace *RequestTrace) {
	if c == nil || trace == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	trace.Transfer = c.TraceTransfer
}

func (c *transferClock) addRead(started time.Time, elapsed time.Duration, n int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.UpstreamReadWait += elapsed
	c.ReadCount++
	if n > 0 {
		c.BytesRead += int64(n)
	}
	if c.FirstReadAt.IsZero() {
		c.FirstReadAt = started
	}
	c.LastReadAt = started.Add(elapsed)
}

func (c *transferClock) addWrite(started time.Time, elapsed time.Duration, n int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ClientWriteWait += elapsed
	c.WriteCount++
	if n > 0 {
		c.BytesWritten += int64(n)
	}
	if c.FirstWriteAt.IsZero() {
		c.FirstWriteAt = started
	}
	c.LastWriteAt = started.Add(elapsed)
}

type timedReader struct {
	r     io.Reader
	clock *transferClock
}

func (r timedReader) Read(p []byte) (int, error) {
	started := time.Now()
	n, err := r.r.Read(p)
	r.clock.addRead(started, time.Since(started), n)
	return n, err
}

type timedWriter struct {
	w     io.Writer
	clock *transferClock
}

func (w timedWriter) Write(p []byte) (int, error) {
	started := time.Now()
	n, err := w.w.Write(p)
	w.clock.addWrite(started, time.Since(started), n)
	return n, err
}

func (w timedWriter) Flush() {
	flusher, ok := w.w.(http.Flusher)
	if !ok {
		return
	}
	started := time.Now()
	flusher.Flush()
	w.clock.addWrite(started, time.Since(started), 0)
}
