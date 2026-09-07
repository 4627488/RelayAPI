package app

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
)

const latencyTraceVersion = 5

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

// latencyTimeline records measured process-local intervals. Nested spans are
// diagnostic context, never additive attribution to remote parties.
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
	t.addSegment(start, end, id, label, owner, "phase", description)
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
		Version:  latencyTraceVersion,
		TotalMS:  elapsedMilliseconds(t.started, completed),
		Boundary: "本进程单调时钟实测。总耗时截止响应边界；计费处理单列。上游尝试及其子阶段可能重叠，不相加。首字节不是首 token，也不代表客户端已收到。",
		Segments: append([]latencySegment(nil), t.segments...),
		Marks:    append([]latencyMark(nil), t.marks...),
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func (t *latencyTimeline) addSegment(start, end time.Time, id, label, owner, track, description string) {
	if start.IsZero() || end.Before(t.started) || end.Before(start) {
		return
	}
	if start.Before(t.started) {
		start = t.started
	}
	segment := latencySegment{
		ID: id, Label: label, Owner: owner, Track: track,
		StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end),
		Description: description,
	}
	t.segments = append(t.segments, segment)
}

func elapsedMilliseconds(start, end time.Time) float64 {
	return float64(end.Sub(start).Microseconds()) / 1000
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
			continue // An unfinished attempt has no measured end; never invent one.
		}
		if attempt.StartedAt.IsZero() || end.Before(attempt.StartedAt) || end.Before(t.started) {
			continue
		}
		attemptStarted := attempt.StartedAt
		if attemptStarted.Before(t.started) {
			attemptStarted = t.started
		}
		label := "上游执行"
		if attempt.Kind == "headers" {
			label = "上游请求至响应头"
		}
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
		if start.IsZero() || end.IsZero() || start.Before(t.started) || end.Before(start) {
			return
		}
		reused := attempt.ConnectionReused
		segment := latencySegment{
			ID: "runtime_attempt_" + strconv.Itoa(attempt.Number) + "_" + suffix, Label: label, Owner: "upstream", Track: "network",
			StartMS: elapsedMilliseconds(t.started, start), DurationMS: elapsedMilliseconds(start, end), Description: description,
			Attempt: attempt.Number, Provider: attempt.Provider, Model: attempt.Model, Credential: attempt.CredentialID,
			Reused: &reused, RemoteAddr: attempt.RemoteAddr,
		}
		t.segments = append(t.segments, segment)
	}
	connectionDescription := "获取供应商连接"
	if attempt.ConnectionReused {
		connectionDescription = "复用供应商连接"
	}
	if attempt.RemoteAddr != "" {
		connectionDescription += " · " + attempt.RemoteAddr
	}
	add(attempt.GetConnAt, attempt.GotConnAt, "connection", "获取上游连接", connectionDescription)
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
