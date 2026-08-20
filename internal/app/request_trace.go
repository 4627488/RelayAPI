package app

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
)

const latencyTraceVersion = 4

const (
	bucketUser     = "user"
	bucketRelay    = "relay"
	bucketUpstream = "upstream"
	bucketMixed    = "mixed"
)

type latencySegment struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Owner       string  `json:"owner"`
	Track       string  `json:"track"`
	Bucket      string  `json:"bucket,omitempty"`
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

type latencyTransfer struct {
	UpstreamReadWaitMS float64 `json:"upstream_read_wait_ms"`
	ClientWriteWaitMS  float64 `json:"client_write_wait_ms"`
	BytesRead          int64   `json:"bytes_read"`
	BytesWritten       int64   `json:"bytes_written"`
	ReadCount          int     `json:"read_count"`
	WriteCount         int     `json:"write_count"`
	FirstReadMS        float64 `json:"first_read_ms,omitempty"`
	LastReadMS         float64 `json:"last_read_ms,omitempty"`
	FirstWriteMS       float64 `json:"first_write_ms,omitempty"`
	LastWriteMS        float64 `json:"last_write_ms,omitempty"`
	WallMS             float64 `json:"wall_ms,omitempty"`
	LocalCopyMS        float64 `json:"local_copy_ms,omitempty"`
}

type latencyAttribution struct {
	UserNetworkMS  float64          `json:"user_network_ms"`
	RelayMS        float64          `json:"relay_ms"`
	UpstreamMS     float64          `json:"upstream_ms"`
	UnattributedMS float64          `json:"unattributed_ms"`
	ObservedSumMS  float64          `json:"observed_sum_ms"`
	OverlapMS      float64          `json:"overlap_ms"`
	Transfer       *latencyTransfer `json:"transfer,omitempty"`
	Notes          []string         `json:"notes,omitempty"`
}

type latencyTrace struct {
	Version     int                `json:"version"`
	TotalMS     float64            `json:"total_ms"`
	Boundary    string             `json:"boundary"`
	Attribution latencyAttribution `json:"attribution"`
	Segments    []latencySegment   `json:"segments"`
	Marks       []latencyMark      `json:"marks,omitempty"`
}

// latencyTimeline records only timestamps Relay can observe: client
// Read/Write blocks, in-process work, and provider connect / Body.Read
// blocks. Provider-internal queues are not visible.
type latencyTimeline struct {
	started  time.Time
	last     time.Time
	segments []latencySegment
	marks    []latencyMark
	transfer upstream.TraceTransfer
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
		Version:     latencyTraceVersion,
		TotalMS:     elapsedMilliseconds(t.started, completed),
		Boundary:    "Relay 只记录本进程时钟：客户端 Read/Write 阻塞、进程内计算、供应商连接与 Body.Read 阻塞。供应商机房内部阶段不可见。读与写在同一拷贝循环中交替，观测合计可以大于墙钟。",
		Attribution: t.attribution(elapsedMilliseconds(t.started, completed)),
		Segments:    append([]latencySegment(nil), t.segments...),
		Marks:       append([]latencyMark(nil), t.marks...),
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func (t *latencyTimeline) addSegment(start, end time.Time, id, label, owner, track, description string) {
	if start.Before(t.started) {
		start = t.started
	}
	segment := latencySegment{
		ID: id, Label: label, Owner: owner, Track: track,
		StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end),
		Description: description,
	}
	segment.Bucket = bucketForSegment(segment)
	t.segments = append(t.segments, segment)
}

func elapsedMilliseconds(start, end time.Time) float64 {
	return float64(end.Sub(start).Microseconds()) / 1000
}

func durationMilliseconds(value time.Duration) float64 {
	if value <= 0 {
		return 0
	}
	return float64(value.Microseconds()) / 1000
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
		t.addTransferSpans(trace.Transfer)
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
		segment.Bucket = bucketForSegment(segment)
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
	t.addTransferSpans(trace.Transfer)
}

func (t *latencyTimeline) addTransferSpans(transfer upstream.TraceTransfer) {
	t.transfer = transfer
	if transfer.UpstreamReadWait > 0 && !transfer.FirstReadAt.IsZero() {
		t.addSegment(transfer.FirstReadAt, transfer.FirstReadAt.Add(transfer.UpstreamReadWait),
			"upstream_read_wait", "读上游阻塞", "upstream", "upstream",
			"response.Body.Read() 从进入到返回的累计时间。含供应商继续推送的等待，不含本进程翻译 CPU。")
	}
	if transfer.ClientWriteWait > 0 && !transfer.FirstWriteAt.IsZero() {
		t.addSegment(transfer.FirstWriteAt, transfer.FirstWriteAt.Add(transfer.ClientWriteWait),
			"client_write_wait", "写客户端阻塞", "downstream", "user",
			"http.ResponseWriter.Write 与 Flush 从进入到返回的累计时间。含客户端接收窗口与中间网络回压。")
	}
}

func (t *latencyTimeline) addAttemptNetworkSpans(attempt upstream.ExecutionAttempt) {
	add := func(start, end time.Time, suffix, label, description string) {
		if start.IsZero() || end.IsZero() || end.Before(start) {
			return
		}
		reused := attempt.ConnectionReused
		segment := latencySegment{
			ID: "runtime_attempt_" + strconv.Itoa(attempt.Number) + "_" + suffix, Label: label, Owner: "upstream", Track: "network",
			StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end), Description: description,
			Attempt: attempt.Number, Provider: attempt.Provider, Model: attempt.Model, Credential: attempt.CredentialID,
			Reused: &reused, RemoteAddr: attempt.RemoteAddr,
		}
		segment.Bucket = bucketForSegment(segment)
		t.segments = append(t.segments, segment)
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

func (t *latencyTimeline) attribution(totalMS float64) latencyAttribution {
	var user, relay, up, mixed float64
	for _, segment := range t.segments {
		switch segment.Bucket {
		case bucketUser:
			user += segment.DurationMS
		case bucketRelay:
			relay += segment.DurationMS
		case bucketUpstream:
			up += segment.DurationMS
		case bucketMixed:
			mixed += segment.DurationMS
		}
	}
	observed := user + relay + up
	overlap := observed - totalMS
	if overlap < 0 {
		overlap = 0
	}
	unattributed := totalMS - observed
	if unattributed < 0 {
		unattributed = 0
	}
	if mixed > 0 && unattributed < mixed {
		unattributed = mixed
	}
	result := latencyAttribution{
		UserNetworkMS:  user,
		RelayMS:        relay,
		UpstreamMS:     up,
		UnattributedMS: unattributed,
		ObservedSumMS:  observed,
		OverlapMS:      overlap,
		Notes: []string{
			"user_network_ms = 读取客户端请求体 + ResponseWriter.Write/Flush 累计阻塞",
			"relay_ms = 鉴权、排队、解析、计费、路由翻译等进程内步骤，不含 Serve 等待",
			"upstream_ms = 连接/DNS/TCP/TLS/发请求/首包等待 + Body.Read 累计阻塞",
			"尝试整段墙钟不计入三桶，避免与网络子段和读写阻塞重复",
			"读写在同一 goroutine 的 Copy 循环中交替；观测合计与墙钟的差为重叠或未覆盖",
		},
	}
	if transfer := encodeTransfer(t.started, t.transfer); transfer != nil {
		result.Transfer = transfer
	}
	return result
}

func encodeTransfer(started time.Time, transfer upstream.TraceTransfer) *latencyTransfer {
	if transfer.ReadCount == 0 && transfer.WriteCount == 0 && transfer.BytesRead == 0 && transfer.BytesWritten == 0 {
		return nil
	}
	encoded := &latencyTransfer{
		UpstreamReadWaitMS: durationMilliseconds(transfer.UpstreamReadWait),
		ClientWriteWaitMS:  durationMilliseconds(transfer.ClientWriteWait),
		BytesRead:          transfer.BytesRead,
		BytesWritten:       transfer.BytesWritten,
		ReadCount:          transfer.ReadCount,
		WriteCount:         transfer.WriteCount,
	}
	if !transfer.FirstReadAt.IsZero() {
		encoded.FirstReadMS = elapsedMilliseconds(started, transfer.FirstReadAt)
	}
	if !transfer.LastReadAt.IsZero() {
		encoded.LastReadMS = elapsedMilliseconds(started, transfer.LastReadAt)
	}
	if !transfer.FirstWriteAt.IsZero() {
		encoded.FirstWriteMS = elapsedMilliseconds(started, transfer.FirstWriteAt)
	}
	if !transfer.LastWriteAt.IsZero() {
		encoded.LastWriteMS = elapsedMilliseconds(started, transfer.LastWriteAt)
	}
	windowStart := firstNonZeroTime(transfer.FirstReadAt, transfer.FirstWriteAt)
	windowEnd := transfer.LastReadAt
	if transfer.LastWriteAt.After(windowEnd) {
		windowEnd = transfer.LastWriteAt
	}
	if !windowStart.IsZero() && !windowEnd.IsZero() && !windowEnd.Before(windowStart) {
		encoded.WallMS = elapsedMilliseconds(windowStart, windowEnd)
		local := encoded.WallMS - encoded.UpstreamReadWaitMS - encoded.ClientWriteWaitMS
		if local > 0 {
			encoded.LocalCopyMS = local
		}
	}
	return encoded
}

func bucketForSegment(segment latencySegment) string {
	switch segment.ID {
	case "read_request_body", "client_write_wait":
		return bucketUser
	case "upstream_read_wait":
		return bucketUpstream
	case "response_transfer", "runtime_response_headers", "runtime_first_body", "websocket_session", "websocket_turn":
		return bucketMixed
	}
	if strings.Contains(segment.ID, "wait_first_byte") || segment.Track == "network" {
		return bucketUpstream
	}
	if strings.Contains(segment.ID, "retry_wait") {
		return bucketRelay
	}
	if segment.Track == "attempt" {
		return ""
	}
	switch segment.Owner {
	case "relay", "queue", "billing", "runtime":
		return bucketRelay
	case "upstream":
		return bucketUpstream
	case "downstream":
		return bucketMixed
	}
	return ""
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
