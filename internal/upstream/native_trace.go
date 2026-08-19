package upstream

import (
	"crypto/tls"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"
)

const maxRequestTraces = 1024

type requestTraceRegistry struct {
	mu     sync.Mutex
	values map[string]*RequestTrace
}

func newRequestTraceRegistry() *requestTraceRegistry {
	return &requestTraceRegistry{values: make(map[string]*RequestTrace)}
}

func (r *nativeRuntime) beginTrace(requestID string) *RequestTrace {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || r.traces == nil {
		return nil
	}
	trace := &RequestTrace{RequestID: requestID, StartedAt: time.Now()}
	r.traces.mu.Lock()
	if len(r.traces.values) >= maxRequestTraces {
		for id := range r.traces.values {
			delete(r.traces.values, id)
			break
		}
	}
	r.traces.values[requestID] = trace
	r.traces.mu.Unlock()
	return trace
}

func (r *nativeRuntime) finishTrace(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || r.traces == nil {
		return
	}
	r.traces.mu.Lock()
	if trace := r.traces.values[requestID]; trace != nil && trace.CompletedAt.IsZero() {
		trace.CompletedAt = time.Now()
	}
	r.traces.mu.Unlock()
}

func (r *nativeRuntime) TakeRequestTrace(requestID string) (RequestTrace, bool) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || r.traces == nil {
		return RequestTrace{}, false
	}
	r.traces.mu.Lock()
	defer r.traces.mu.Unlock()
	trace := r.traces.values[requestID]
	if trace == nil {
		return RequestTrace{}, false
	}
	delete(r.traces.values, requestID)
	return *trace, true
}

func (t *RequestTrace) setSelection(credential *nativeCredential, model, translation string) {
	if t == nil || credential == nil {
		return
	}
	t.Provider = credential.Provider
	t.CredentialID = credential.ID
	t.Model = model
	t.Translation = translation
}

func (t *RequestTrace) addAttempt(attempt ExecutionAttempt) {
	if t == nil {
		return
	}
	t.Attempts = append(t.Attempts, attempt)
}

func providerClientTrace() (*clientHTTPTrace, *httptrace.ClientTrace) {
	state := &clientHTTPTrace{}
	trace := &httptrace.ClientTrace{
		GetConn: func(string) { state.setTime(&state.getConn, time.Now()) },
		GotConn: func(info httptrace.GotConnInfo) {
			state.mu.Lock()
			state.gotConn = time.Now()
			state.reused = info.Reused
			if info.Conn != nil && info.Conn.RemoteAddr() != nil {
				state.remoteAddr = info.Conn.RemoteAddr().String()
			}
			state.mu.Unlock()
		},
		DNSStart:             func(httptrace.DNSStartInfo) { state.setTime(&state.dnsStart, time.Now()) },
		DNSDone:              func(httptrace.DNSDoneInfo) { state.setTime(&state.dnsDone, time.Now()) },
		ConnectStart:         func(_, _ string) { state.setTime(&state.connectStart, time.Now()) },
		ConnectDone:          func(_, _ string, _ error) { state.setTime(&state.connectDone, time.Now()) },
		TLSHandshakeStart:    func() { state.setTime(&state.tlsStart, time.Now()) },
		TLSHandshakeDone:     func(tls.ConnectionState, error) { state.setTime(&state.tlsDone, time.Now()) },
		WroteRequest:         func(httptrace.WroteRequestInfo) { state.setTime(&state.wroteRequest, time.Now()) },
		GotFirstResponseByte: func() { state.setTime(&state.firstResponseByte, time.Now()) },
	}
	return state, trace
}

type clientHTTPTrace struct {
	mu                                                              sync.Mutex
	getConn, gotConn, wroteRequest, firstResponseByte               time.Time
	dnsStart, dnsDone, connectStart, connectDone, tlsStart, tlsDone time.Time
	reused                                                          bool
	remoteAddr                                                      string
}

func (t *clientHTTPTrace) setTime(target *time.Time, value time.Time) {
	t.mu.Lock()
	if target.IsZero() {
		*target = value
	}
	t.mu.Unlock()
}

func (t *clientHTTPTrace) snapshot() clientHTTPTrace {
	if t == nil {
		return clientHTTPTrace{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return clientHTTPTrace{
		getConn: t.getConn, gotConn: t.gotConn, wroteRequest: t.wroteRequest, firstResponseByte: t.firstResponseByte,
		dnsStart: t.dnsStart, dnsDone: t.dnsDone, connectStart: t.connectStart, connectDone: t.connectDone,
		tlsStart: t.tlsStart, tlsDone: t.tlsDone, reused: t.reused, remoteAddr: t.remoteAddr,
	}
}
