package app

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
)

// generatedContent recognizes actual text, visible reasoning, refusal and tool
// arguments in Responses, Chat, Messages and Gemini. Metadata is not content.
func generatedContent(payload []byte) (text, reasoning string) {
	var e map[string]any
	if json.Unmarshal(payload, &e) != nil {
		return
	}
	str := func(v any) string { s, _ := v.(string); return s }
	obj := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	arr := func(v any) []any { a, _ := v.([]any); return a }
	typ := str(e["type"])
	switch typ {
	case "response.output_text.delta", "response.refusal.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
		text = str(e["delta"])
	case "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
		reasoning = str(e["delta"])
	case "content_block_delta":
		d := obj(e["delta"])
		text = str(d["text"]) + str(d["partial_json"])
		reasoning = str(d["thinking"])
	}
	for _, c := range arr(e["choices"]) {
		d := obj(obj(c)["delta"])
		text += str(d["content"]) + str(obj(d["function_call"])["arguments"])
		reasoning += str(d["reasoning"]) + str(d["reasoning_content"])
		for _, call := range arr(d["tool_calls"]) {
			text += str(obj(obj(call)["function"])["arguments"])
		}
	}
	for _, c := range arr(e["candidates"]) {
		for _, p := range arr(obj(obj(c)["content"])["parts"]) {
			part := obj(p)
			if part["thought"] == true {
				reasoning += str(part["text"])
			} else {
				text += str(part["text"])
				if f := obj(part["functionCall"]); len(f) > 0 {
					b, _ := json.Marshal(f)
					text += string(b)
				}
			}
		}
	}
	return
}
func hasGeneratedDelta(payload []byte) bool {
	t, r := generatedContent(payload)
	return t != "" || r != ""
}

type contentPoint struct {
	at time.Time
	n  int64
}

// Only a pending SSE event and bounded timing samples are retained.
type firstTokenObserver struct {
	eventLimit              int
	onEvent                 func([]byte)
	Usage                   billing.Result
	At, TextAt, ReasoningAt time.Time
	line, data              []byte
	dropping, lineNonEmpty  bool
	text, all               []contentPoint
	textN, allN             int64
	overflow                bool
}

func (o *firstTokenObserver) observe(payload []byte, at time.Time) {
	if o == nil {
		return
	}
	if o.onEvent != nil {
		o.onEvent(payload)
	}
	if bytes.Contains(payload, []byte(`"usage"`)) || bytes.Contains(payload, []byte(`"usageMetadata"`)) || bytes.Contains(payload, []byte(`"model"`)) {
		billing.Merge(&o.Usage, billing.ParseResponse(payload))
	}
	t, r := generatedContent(payload)
	if t == "" && r == "" {
		return
	}
	if o.At.IsZero() {
		o.At = at
	}
	if t != "" && o.TextAt.IsZero() {
		o.TextAt = at
	}
	if r != "" && o.ReasoningAt.IsZero() {
		o.ReasoningAt = at
	}
	o.allN += int64(len(t) + len(r))
	o.textN += int64(len(t))
	if len(o.all) >= 4096 {
		o.overflow = true
		return
	}
	o.all = append(o.all, contentPoint{at, o.allN})
	if t != "" {
		o.text = append(o.text, contentPoint{at, o.textN})
	}
}
func (o *firstTokenObserver) flow(reasoning bool) int64 {
	if o == nil || o.overflow {
		return 0
	}
	points, total := o.all, o.allN
	if reasoning {
		points, total = o.text, o.textN
	}
	if len(points) < 2 || total <= 0 {
		return 0
	}
	var first, last time.Time
	for _, p := range points {
		if first.IsZero() && float64(p.n) >= float64(total)*.1 {
			first = p.at
		}
		if float64(p.n) >= float64(total)*.9 {
			last = p.at
			break
		}
	}
	// A known burst must not be confused with an unknown flow (0).
	if first.IsZero() || last.IsZero() {
		return 0
	}
	return max64(1, int64(float64(last.Sub(first).Milliseconds())/.8))
}
func (o *firstTokenObserver) Write(payload []byte, at time.Time) {
	if o == nil {
		return
	}
	limit := o.eventLimit
	if limit <= 0 {
		limit = 1 << 20
	}
	for _, v := range payload {
		if v != '\n' {
			if v != '\r' {
				o.lineNonEmpty = true
			}
			if len(o.line)+len(o.data) >= limit {
				o.dropping = true
				o.line = nil
				o.data = nil
			}
			if !o.dropping {
				o.line = append(o.line, v)
			}
			continue
		}
		line := bytes.TrimSuffix(o.line, []byte{'\r'})
		if !o.lineNonEmpty {
			if !o.dropping {
				o.observe(o.data, at)
			}
			o.data = nil
			o.dropping = false
		} else if !o.dropping && bytes.HasPrefix(line, []byte("data:")) {
			if len(o.data) > 0 {
				o.data = append(o.data, '\n')
			}
			o.data = append(o.data, bytes.TrimPrefix(line[5:], []byte{' '})...)
		}
		o.line = nil
		o.lineNonEmpty = false
	}
}
