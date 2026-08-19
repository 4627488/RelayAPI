package app

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http/httptrace"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
)

const latencyTraceVersion = 3

type latencySegment struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Owner       string  `json:"owner"`
	Track       string  `json:"track"`
	StartMS     float64 `json:"start_ms"`
	DurationMS  float64 `json:"duration_ms"`
	Description string  `json:"description,omitempty"`
	Attempt     int     `json:"attempt,omitempty"`
	Status      string  `json:"status,omitempty"`
	Provider    string  `json:"provider,omitempty"`
	Model       string  `json:"model,omitempty"`
	Credential  string  `json:"credential,omitempty"`
	Error       string  `json:"error,omitempty"`
	Reused      *bool   `json:"reused,omitempty"`
	RemoteAddr  string  `json:"remote_addr,omitempty"`
}

type latencyMark struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	OffsetMS float64 `json:"offset_ms"`
}

type latencyTrace struct {
	Version  int              `json:"version"`
	TotalMS  float64          `json:"total_ms"`
	Boundary string           `json:"boundary"`
	Segments []latencySegment `json:"segments"`
	Marks    []latencyMark    `json:"marks,omitempty"`
}

// latencyTimeline records only timestamps Relay can observe. The upstream
// provider is behind the native runtime, so time after the request is written and
// before it returns headers is deliberately reported as one opaque upstream
// span instead of presenting guessed DNS/TLS timings as facts.
type latencyTimeline struct {
	started  time.Time
	last     time.Time
	segments []latencySegment
	marks    []latencyMark
}

func newLatencyTimeline(started time.Time) *latencyTimeline {
	return &latencyTimeline{started: started, last: started}
}

func (t *latencyTimeline) Step(at time.Time, id, label, owner, description string) {
	if t == nil || at.Before(t.last) {
		return
	}
	t.addSegment(t.last, at, id, label, owner, "critical", description)
	t.last = at
}

func (t *latencyTimeline) Span(start, end time.Time, id, label, owner, description string) {
	if t == nil || start.IsZero() || end.IsZero() || end.Before(start) {
		return
	}
	t.addSegment(start, end, id, label, owner, "network", description)
}

func (t *latencyTimeline) Mark(at time.Time, id, label string) {
	if t == nil || at.IsZero() || at.Before(t.started) {
		return
	}
	t.marks = append(t.marks, latencyMark{ID: id, Label: label, OffsetMS: elapsedMilliseconds(t.started, at)})
}

func (t *latencyTimeline) JSON(completed time.Time) string {
	if t == nil {
		return "{}"
	}
	if completed.Before(t.started) {
		completed = t.started
	}
	payload := latencyTrace{
		Version: latencyTraceVersion, TotalMS: elapsedMilliseconds(t.started, completed),
		Boundary: "Relay 与原生运行时使用进程内实测时间戳；供应商服务端内部阶段止于响应首包",
		Segments: append([]latencySegment(nil), t.segments...), Marks: append([]latencyMark(nil), t.marks...),
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func (t *latencyTimeline) addSegment(start, end time.Time, id, label, owner, track, description string) {
	if start.Before(t.started) {
		start = t.started
	}
	t.segments = append(t.segments, latencySegment{
		ID: id, Label: label, Owner: owner, Track: track,
		StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end),
		Description: description,
	})
}

func elapsedMilliseconds(start, end time.Time) float64 {
	return float64(end.Sub(start).Microseconds()) / 1000
}

type clientHTTPTrace struct {
	mu sync.Mutex

	getConn, gotConn, wroteHeaders, wroteRequest, firstResponseByte time.Time
	dnsStart, dnsDone, connectStart, connectDone                    time.Time
	tlsStart, tlsDone                                               time.Time
	reused                                                          bool
	remoteAddr                                                      string
}

func newClientHTTPTrace() (*clientHTTPTrace, *httptrace.ClientTrace) {
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
		DNSStart: func(httptrace.DNSStartInfo) { state.setTime(&state.dnsStart, time.Now()) },
		DNSDone:  func(httptrace.DNSDoneInfo) { state.setTime(&state.dnsDone, time.Now()) },
		ConnectStart: func(_, _ string) {
			state.setTime(&state.connectStart, time.Now())
		},
		ConnectDone:       func(_, _ string, _ error) { state.setTime(&state.connectDone, time.Now()) },
		TLSHandshakeStart: func() { state.setTime(&state.tlsStart, time.Now()) },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			state.setTime(&state.tlsDone, time.Now())
		},
		WroteHeaders: func() { state.setTime(&state.wroteHeaders, time.Now()) },
		WroteRequest: func(httptrace.WroteRequestInfo) {
			state.setTime(&state.wroteRequest, time.Now())
		},
		GotFirstResponseByte: func() { state.setTime(&state.firstResponseByte, time.Now()) },
		Got1xxResponse:       func(int, textproto.MIMEHeader) error { return nil },
	}
	return state, trace
}

func (t *clientHTTPTrace) setTime(target *time.Time, value time.Time) {
	t.mu.Lock()
	if target.IsZero() {
		*target = value
	}
	t.mu.Unlock()
}

type clientHTTPTraceSnapshot struct {
	getConn, gotConn, wroteHeaders, wroteRequest, firstResponseByte time.Time
	dnsStart, dnsDone, connectStart, connectDone                    time.Time
	tlsStart, tlsDone                                               time.Time
	reused                                                          bool
	remoteAddr                                                      string
}

func (t *clientHTTPTrace) snapshot() clientHTTPTraceSnapshot {
	if t == nil {
		return clientHTTPTraceSnapshot{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return clientHTTPTraceSnapshot{
		getConn: t.getConn, gotConn: t.gotConn, wroteHeaders: t.wroteHeaders, wroteRequest: t.wroteRequest,
		firstResponseByte: t.firstResponseByte, dnsStart: t.dnsStart, dnsDone: t.dnsDone,
		connectStart: t.connectStart, connectDone: t.connectDone, tlsStart: t.tlsStart, tlsDone: t.tlsDone,
		reused: t.reused, remoteAddr: t.remoteAddr,
	}
}

func (t *latencyTimeline) AddHTTPTrace(state *clientHTTPTrace, completed time.Time) {
	if t == nil {
		return
	}
	snapshot := state.snapshot()
	connectionEnd := snapshot.gotConn
	if connectionEnd.IsZero() {
		connectionEnd = firstNonZeroTime(snapshot.wroteRequest, completed)
	}
	detail := "获取 Relay 到原生运行时 的 HTTP 连接"
	if snapshot.reused {
		detail = "复用 Relay 到原生运行时 的空闲连接"
	}
	if snapshot.remoteAddr != "" {
		detail += " · " + snapshot.remoteAddr
	}
	t.Step(connectionEnd, "upstream_connection", "连接原生运行时", "upstream", detail)
	requestWritten := firstNonZeroTime(snapshot.wroteRequest, snapshot.wroteHeaders, connectionEnd)
	t.Step(requestWritten, "upstream_request_write", "写入 Upstream 请求", "upstream", "请求头与正文已写入 Upstream")
	firstHeader := firstNonZeroTime(snapshot.firstResponseByte, completed)
	t.Step(firstHeader, "upstream_wait_headers", "原生运行时 / 上游处理", "upstream", "包含凭据路由、凭据选择、重试，以及供应商生成响应头前的内部耗时")
	t.Step(completed, "upstream_response_headers", "读取响应头", "upstream", "Relay 已收到 上游响应头")

	t.Span(snapshot.getConn, snapshot.gotConn, "http_connection_pool", "连接池等待", "upstream", detail)
	t.Span(snapshot.dnsStart, snapshot.dnsDone, "http_dns", "DNS 查询", "upstream", "Relay 到原生运行时 的域名解析")
	t.Span(snapshot.connectStart, snapshot.connectDone, "http_tcp", "TCP 连接", "upstream", "Relay 到原生运行时 的 TCP 建连")
	t.Span(snapshot.tlsStart, snapshot.tlsDone, "http_tls", "TLS 握手", "upstream", "Relay 到原生运行时 的 TLS 握手")
	t.Span(snapshot.gotConn, snapshot.wroteRequest, "http_request_write", "HTTP 请求写入", "upstream", "底层 Transport 写入请求")
}

func (t *latencyTimeline) AddUpstreamTrace(trace upstream.RequestTrace) {
	if t == nil || trace.RequestID == "" {
		return
	}
	attempts := trace.Attempts
	if len(attempts) == 0 {
		if !trace.StartedAt.IsZero() && !trace.CompletedAt.IsZero() && !trace.CompletedAt.Before(trace.StartedAt) {
			t.addSegment(trace.StartedAt, trace.CompletedAt, "runtime_dispatch", "路由、翻译与凭据选择", "runtime", "runtime",
				"请求未进入供应商执行；通常是路由、凭据可用性或请求翻译阶段返回")
		}
		return
	}
	firstStarted := attempts[0].StartedAt
	if !trace.StartedAt.IsZero() && !firstStarted.IsZero() && !firstStarted.Before(trace.StartedAt) {
		description := "原生运行时解析协议、路由模型并完成本次凭据选择"
		if trace.Translation != "" && trace.Translation != "passthrough" {
			description += " · " + trace.Translation
		}
		t.addSegment(trace.StartedAt, firstStarted, "runtime_dispatch", "路由、翻译与凭据选择", "runtime", "runtime", description)
	}
	for index, attempt := range attempts {
		end := attempt.CompletedAt
		if end.IsZero() {
			end = firstNonZeroTime(attempt.HeadersAt, attempt.FirstResponseAt, trace.CompletedAt)
		}
		if end.IsZero() || end.Before(attempt.StartedAt) || end.Before(t.started) {
			continue
		}
		attemptStarted := attempt.StartedAt
		if attemptStarted.Before(t.started) {
			attemptStarted = t.started
		}
		label := "上游执行"
		if len(attempts) > 1 {
			label = "上游尝试 " + strconv.Itoa(attempt.Number)
		}
		segment := latencySegment{
			ID: "runtime_attempt_" + strconv.Itoa(attempt.Number), Label: label, Owner: "upstream", Track: "attempt",
			StartMS: elapsedMilliseconds(t.started, attemptStarted), DurationMS: elapsedMilliseconds(attemptStarted, end),
			Description: attemptDescription(attempt), Attempt: attempt.Number, Status: attempt.Status,
			Provider: attempt.Provider, Model: attempt.Model, Credential: attempt.CredentialID, Error: attempt.Error,
		}
		t.segments = append(t.segments, segment)
		if !attempt.HeadersAt.IsZero() {
			t.Mark(attempt.HeadersAt, segment.ID+"_headers", "上游响应头")
		}
		t.addAttemptNetworkSpans(attempt)
		if index+1 < len(attempts) {
			next := attempts[index+1]
			if !end.IsZero() && !next.StartedAt.IsZero() && next.StartedAt.After(end) {
				t.addSegment(end, next.StartedAt, "runtime_retry_wait_"+strconv.Itoa(attempt.Number), "重试等待", "queue", "attempt",
					"等待下一轮调度或令牌刷新")
			}
		}
	}
}

func (t *latencyTimeline) addAttemptNetworkSpans(attempt upstream.ExecutionAttempt) {
	add := func(start, end time.Time, suffix, label, description string) {
		if start.IsZero() || end.IsZero() || end.Before(start) {
			return
		}
		reused := attempt.ConnectionReused
		t.segments = append(t.segments, latencySegment{
			ID: "runtime_attempt_" + strconv.Itoa(attempt.Number) + "_" + suffix, Label: label, Owner: "upstream", Track: "network",
			StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end), Description: description,
			Attempt: attempt.Number, Provider: attempt.Provider, Model: attempt.Model, Credential: attempt.CredentialID,
			Reused: &reused, RemoteAddr: attempt.RemoteAddr,
		})
	}
	connectionDescription := "获取供应商连接"
	if attempt.ConnectionReused {
		connectionDescription = "复用供应商连接"
	}
	if attempt.RemoteAddr != "" {
		connectionDescription += " · " + attempt.RemoteAddr
	}
	add(attempt.GetConnAt, attempt.GotConnAt, "connection", "连接池等待", connectionDescription)
	add(attempt.DNSStartedAt, attempt.DNSCompletedAt, "dns", "供应商 DNS", "解析供应商域名")
	add(attempt.ConnectStartedAt, attempt.ConnectCompletedAt, "tcp", "供应商 TCP", "到供应商的 TCP 建连")
	add(attempt.TLSStartedAt, attempt.TLSCompletedAt, "tls", "供应商 TLS", "与供应商完成 TLS 握手")
	add(attempt.GotConnAt, attempt.RequestWrittenAt, "request_write", "发送上游请求", "写入供应商请求头与正文")
	add(attempt.RequestWrittenAt, attempt.FirstResponseAt, "wait_first_byte", "供应商首包等待", "供应商接收请求后到返回首个响应字节")
}

func attemptDescription(attempt upstream.ExecutionAttempt) string {
	parts := make([]string, 0, 4)
	if attempt.Provider != "" {
		parts = append(parts, attempt.Provider)
	}
	if attempt.Model != "" {
		parts = append(parts, attempt.Model)
	}
	if attempt.CredentialID != "" {
		parts = append(parts, "凭据 "+attempt.CredentialID)
	}
	if attempt.Error != "" {
		parts = append(parts, attempt.Error)
	}
	return strings.Join(parts, " · ")
}

func (a *App) addNativeRuntimeTrace(timeline *latencyTimeline, requestID string) {
	if a == nil || a.nativeRuntime == nil || timeline == nil {
		return
	}
	if trace, ok := a.nativeRuntime.TakeRequestTrace(requestID); ok {
		timeline.AddUpstreamTrace(trace)
	}
}

func firstNonZeroTime(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Time{}
}

type observedReader struct {
	io.Reader
	onFirstByte func()
}

func (r *observedReader) Read(payload []byte) (int, error) {
	n, err := r.Reader.Read(payload)
	if n > 0 && r.onFirstByte != nil {
		r.onFirstByte()
		r.onFirstByte = nil
	}
	return n, err
}
