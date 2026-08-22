package relaybridge

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

const requestTraceTTL = 30 * time.Minute

// RequestTrace is the secret-free execution trace observed inside embedded CPA.
// Times are kept as monotonic time.Time values until Relay consumes the trace,
// avoiding precision loss and wall-clock skew inside the process.
type RequestTrace struct {
	RequestID   string
	StartedAt   time.Time
	CompletedAt time.Time
	Attempts    []ExecutionAttempt
}

// ExecutionAttempt describes one real invocation of a CPA provider executor.
// A request can contain multiple attempts because of model pools, credential
// rotation, an OAuth refresh replay, or configured cooldown retries.
type ExecutionAttempt struct {
	Number             int
	Kind               string
	Provider           string
	Model              string
	CredentialID       string
	StartedAt          time.Time
	HeadersAt          time.Time
	FirstChunkAt       time.Time
	CompletedAt        time.Time
	Status             string
	Error              string
	ConnectionReused   bool
	RemoteAddr         string
	GetConnAt          time.Time
	GotConnAt          time.Time
	DNSStartedAt       time.Time
	DNSCompletedAt     time.Time
	ConnectStartedAt   time.Time
	ConnectCompletedAt time.Time
	TLSStartedAt       time.Time
	TLSCompletedAt     time.Time
	RequestWrittenAt   time.Time
	FirstResponseAt    time.Time
}

type requestTraceRegistry struct {
	mu     sync.Mutex
	traces map[string]*RequestTrace
}

func newRequestTraceRegistry() *requestTraceRegistry {
	return &requestTraceRegistry{traces: make(map[string]*RequestTrace)}
}

func (r *Runtime) requestTraceMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader("X-Relay-Request-ID"))
		if requestID == "" || r == nil || r.traces == nil {
			c.Next()
			return
		}
		r.traces.begin(requestID, time.Now())
		defer func() { r.traces.complete(requestID, time.Now()) }()
		c.Next()
	}
}

func (r *requestTraceRegistry) begin(requestID string, at time.Time) {
	requestID = strings.TrimSpace(requestID)
	if r == nil || requestID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, trace := range r.traces {
		if trace == nil || (!trace.StartedAt.IsZero() && at.Sub(trace.StartedAt) > requestTraceTTL) {
			delete(r.traces, id)
		}
	}
	r.traces[requestID] = &RequestTrace{RequestID: requestID, StartedAt: at}
}

func (r *requestTraceRegistry) complete(requestID string, at time.Time) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if trace := r.traces[strings.TrimSpace(requestID)]; trace != nil {
		trace.CompletedAt = at
	}
	r.mu.Unlock()
}

func (r *requestTraceRegistry) startAttempt(requestID, kind, provider, model, credentialID string, at time.Time) int {
	if r == nil {
		return 0
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	trace := r.traces[requestID]
	if trace == nil {
		trace = &RequestTrace{RequestID: requestID, StartedAt: at}
		r.traces[requestID] = trace
	}
	number := len(trace.Attempts) + 1
	trace.Attempts = append(trace.Attempts, ExecutionAttempt{
		Number: number, Kind: kind, Provider: strings.TrimSpace(provider), Model: strings.TrimSpace(model),
		CredentialID: strings.TrimSpace(credentialID), StartedAt: at, Status: "running",
	})
	return number
}

func (r *requestTraceRegistry) updateAttempt(requestID string, number int, update func(*ExecutionAttempt)) {
	if r == nil || number <= 0 || update == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	trace := r.traces[strings.TrimSpace(requestID)]
	if trace == nil || number > len(trace.Attempts) {
		return
	}
	update(&trace.Attempts[number-1])
}

func (r *requestTraceRegistry) take(requestID string) (RequestTrace, bool) {
	if r == nil {
		return RequestTrace{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	requestID = strings.TrimSpace(requestID)
	trace := r.traces[requestID]
	if trace == nil {
		return RequestTrace{}, false
	}
	delete(r.traces, requestID)
	return cloneRequestTrace(trace), true
}

func (r *requestTraceRegistry) snapshot(requestID string) (RequestTrace, bool) {
	if r == nil {
		return RequestTrace{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	trace := r.traces[strings.TrimSpace(requestID)]
	if trace == nil {
		return RequestTrace{}, false
	}
	return cloneRequestTrace(trace), true
}

func cloneRequestTrace(trace *RequestTrace) RequestTrace {
	if trace == nil {
		return RequestTrace{}
	}
	result := *trace
	result.Attempts = append([]ExecutionAttempt(nil), trace.Attempts...)
	return result
}

type observedExecutor struct {
	inner  cliproxyauth.ProviderExecutor
	traces *requestTraceRegistry
}

func observeExecutor(inner cliproxyauth.ProviderExecutor, traces *requestTraceRegistry) cliproxyauth.ProviderExecutor {
	if inner == nil {
		return nil
	}
	return &observedExecutor{inner: inner, traces: traces}
}

func (e *observedExecutor) Identifier() string { return e.inner.Identifier() }

func (e *observedExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	state, traced := e.begin(ctx, auth, req, opts, "request")
	response, err := e.inner.Execute(traced, resolveBailianCacheAuth(auth, req, opts), req, opts)
	state.finish(err, "complete")
	return response, err
}

func (e *observedExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	state, traced := e.begin(ctx, auth, req, opts, "stream")
	result, err := e.inner.ExecuteStream(traced, resolveBailianCacheAuth(auth, req, opts), req, opts)
	if err != nil || result == nil || result.Chunks == nil {
		state.finish(err, "failed")
		return result, err
	}
	state.headers(time.Now())
	chunks := make(chan cliproxyexecutor.StreamChunk)
	go func() {
		defer close(chunks)
		first := true
		var terminal error
		for chunk := range result.Chunks {
			if first && len(chunk.Payload) > 0 {
				first = false
				state.firstChunk(time.Now())
			}
			if chunk.Err != nil {
				terminal = chunk.Err
			}
			if ctx == nil {
				chunks <- chunk
				continue
			}
			select {
			case chunks <- chunk:
			case <-ctx.Done():
				terminal = ctx.Err()
				state.finish(terminal, "canceled")
				drainStream(result.Chunks)
				return
			}
		}
		state.finish(terminal, "complete")
	}()
	return &cliproxyexecutor.StreamResult{Headers: result.Headers, Chunks: chunks}, nil
}

func drainStream(chunks <-chan cliproxyexecutor.StreamChunk) {
	go func() {
		for range chunks {
		}
	}()
}

func (e *observedExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	state, traced := e.begin(ctx, auth, req, opts, "count")
	response, err := e.inner.CountTokens(traced, auth, req, opts)
	state.finish(err, "complete")
	return response, err
}

func (e *observedExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	return e.inner.Refresh(ctx, auth)
}

func (e *observedExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	return e.inner.HttpRequest(ctx, auth, req)
}

// The manager discovers several optional executor capabilities by interface
// assertion. Delegate them so observation never changes routing or auth behavior.
func (e *observedExecutor) RequestToFormat(req cliproxyexecutor.Request, opts cliproxyexecutor.Options) sdktranslator.Format {
	if resolver, ok := e.inner.(interface {
		RequestToFormat(cliproxyexecutor.Request, cliproxyexecutor.Options) sdktranslator.Format
	}); ok {
		return resolver.RequestToFormat(req, opts)
	}
	return ""
}

func (e *observedExecutor) ShouldPrepareRequestAuth(auth *cliproxyauth.Auth) bool {
	preparer, ok := e.inner.(cliproxyauth.RequestAuthPreparer)
	return ok && preparer.ShouldPrepareRequestAuth(auth)
}

func (e *observedExecutor) PrepareRequestAuth(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	if preparer, ok := e.inner.(cliproxyauth.RequestAuthPreparer); ok {
		return preparer.PrepareRequestAuth(ctx, auth)
	}
	return auth, nil
}

func (e *observedExecutor) PrepareRequest(req *http.Request, auth *cliproxyauth.Auth) error {
	if preparer, ok := e.inner.(cliproxyauth.RequestPreparer); ok {
		return preparer.PrepareRequest(req, auth)
	}
	return &cliproxyauth.Error{Code: "not_supported", Message: "executor does not support HTTP request preparation"}
}

func (e *observedExecutor) CloseExecutionSession(sessionID string) {
	if closer, ok := e.inner.(cliproxyauth.ExecutionSessionCloser); ok {
		closer.CloseExecutionSession(sessionID)
	}
}

type attemptState struct {
	traces    *requestTraceRegistry
	requestID string
	number    int
	http      *attemptHTTPTrace
	once      sync.Once
}

func (e *observedExecutor) begin(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options, kind string) (*attemptState, context.Context) {
	requestID := requestIDFromOptions(opts)
	credentialID := ""
	if auth != nil {
		credentialID = auth.ID
	}
	started := time.Now()
	number := e.traces.startAttempt(requestID, kind, e.Identifier(), req.Model, credentialID, started)
	state := &attemptState{traces: e.traces, requestID: requestID, number: number, http: &attemptHTTPTrace{}}
	if ctx == nil {
		ctx = context.Background()
	}
	return state, httptrace.WithClientTrace(ctx, state.http.clientTrace())
}

func requestIDFromOptions(opts cliproxyexecutor.Options) string {
	if opts.Headers == nil {
		return ""
	}
	return strings.TrimSpace(opts.Headers.Get("X-Relay-Request-ID"))
}

func (s *attemptState) headers(at time.Time) {
	if s == nil {
		return
	}
	s.traces.updateAttempt(s.requestID, s.number, func(attempt *ExecutionAttempt) { attempt.HeadersAt = at })
}

func (s *attemptState) firstChunk(at time.Time) {
	if s == nil {
		return
	}
	s.traces.updateAttempt(s.requestID, s.number, func(attempt *ExecutionAttempt) {
		if attempt.FirstChunkAt.IsZero() {
			attempt.FirstChunkAt = at
		}
	})
}

func (s *attemptState) finish(err error, successStatus string) {
	if s == nil {
		return
	}
	s.once.Do(func() {
		completed := time.Now()
		snapshot := s.http.snapshot()
		s.traces.updateAttempt(s.requestID, s.number, func(attempt *ExecutionAttempt) {
			attempt.CompletedAt = completed
			attempt.Status = successStatus
			if err != nil {
				attempt.Status = "failed"
				attempt.Error = classifyTraceError(err)
			}
			attempt.ConnectionReused = snapshot.reused
			attempt.RemoteAddr = snapshot.remoteAddr
			attempt.GetConnAt = snapshot.getConn
			attempt.GotConnAt = snapshot.gotConn
			attempt.DNSStartedAt = snapshot.dnsStart
			attempt.DNSCompletedAt = snapshot.dnsDone
			attempt.ConnectStartedAt = snapshot.connectStart
			attempt.ConnectCompletedAt = snapshot.connectDone
			attempt.TLSStartedAt = snapshot.tlsStart
			attempt.TLSCompletedAt = snapshot.tlsDone
			attempt.RequestWrittenAt = snapshot.wroteRequest
			attempt.FirstResponseAt = snapshot.firstResponseByte
		})
	})
}

func classifyTraceError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "request_canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	var authErr *cliproxyauth.Error
	if errors.As(err, &authErr) && authErr != nil && strings.TrimSpace(authErr.Code) != "" {
		return strings.TrimSpace(authErr.Code)
	}
	if statusErr, ok := err.(interface{ StatusCode() int }); ok && statusErr.StatusCode() > 0 {
		return http.StatusText(statusErr.StatusCode())
	}
	return "upstream_error"
}

type attemptHTTPTrace struct {
	mu                                                             sync.Mutex
	getConn, gotConn, dnsStart, dnsDone, connectStart, connectDone time.Time
	tlsStart, tlsDone, wroteRequest, firstResponseByte             time.Time
	reused                                                         bool
	remoteAddr                                                     string
}

func (t *attemptHTTPTrace) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GetConn: func(string) { t.set(&t.getConn, time.Now()) },
		GotConn: func(info httptrace.GotConnInfo) {
			t.mu.Lock()
			if t.gotConn.IsZero() {
				t.gotConn = time.Now()
				t.reused = info.Reused
				if info.Conn != nil && info.Conn.RemoteAddr() != nil {
					t.remoteAddr = info.Conn.RemoteAddr().String()
				}
			}
			t.mu.Unlock()
		},
		DNSStart:             func(httptrace.DNSStartInfo) { t.set(&t.dnsStart, time.Now()) },
		DNSDone:              func(httptrace.DNSDoneInfo) { t.set(&t.dnsDone, time.Now()) },
		ConnectStart:         func(_, _ string) { t.set(&t.connectStart, time.Now()) },
		ConnectDone:          func(_, _ string, _ error) { t.set(&t.connectDone, time.Now()) },
		TLSHandshakeStart:    func() { t.set(&t.tlsStart, time.Now()) },
		TLSHandshakeDone:     func(tls.ConnectionState, error) { t.set(&t.tlsDone, time.Now()) },
		WroteRequest:         func(httptrace.WroteRequestInfo) { t.set(&t.wroteRequest, time.Now()) },
		GotFirstResponseByte: func() { t.set(&t.firstResponseByte, time.Now()) },
		Got1xxResponse:       func(int, textproto.MIMEHeader) error { return nil },
	}
}

func (t *attemptHTTPTrace) set(target *time.Time, at time.Time) {
	t.mu.Lock()
	if target.IsZero() {
		*target = at
	}
	t.mu.Unlock()
}

func (t *attemptHTTPTrace) snapshot() attemptHTTPTrace {
	if t == nil {
		return attemptHTTPTrace{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return attemptHTTPTrace{
		getConn: t.getConn, gotConn: t.gotConn, dnsStart: t.dnsStart, dnsDone: t.dnsDone,
		connectStart: t.connectStart, connectDone: t.connectDone, tlsStart: t.tlsStart, tlsDone: t.tlsDone,
		wroteRequest: t.wroteRequest, firstResponseByte: t.firstResponseByte,
		reused: t.reused, remoteAddr: t.remoteAddr,
	}
}

var _ cliproxyauth.ProviderExecutor = (*observedExecutor)(nil)
var _ cliproxyauth.RequestAuthPreparer = (*observedExecutor)(nil)
var _ cliproxyauth.RequestPreparer = (*observedExecutor)(nil)
var _ cliproxyauth.ExecutionSessionCloser = (*observedExecutor)(nil)
