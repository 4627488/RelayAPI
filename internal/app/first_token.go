package app

import (
	"bytes"
	"encoding/json"
	"time"
)

// A generated delta is observable; role, created, heartbeat and usage events
// are not tokens. This measures arrival at Relay, not provider generation time.
func hasGeneratedDelta(payload []byte) bool {
	var event struct {
		Type    string `json:"type"`
		Delta   string `json:"delta"`
		Choices []struct {
			Delta struct {
				Content          string `json:"content"`
				Reasoning        string `json:"reasoning"`
				ReasoningContent string `json:"reasoning_content"`
				ToolCalls        []struct {
					Function struct {
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
				FunctionCall struct {
					Arguments string `json:"arguments"`
				} `json:"function_call"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	switch event.Type {
	case "response.output_text.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta", "response.refusal.delta":
		return event.Delta != ""
	}
	for _, choice := range event.Choices {
		d := choice.Delta
		if d.Content != "" || d.Reasoning != "" || d.ReasoningContent != "" || d.FunctionCall.Arguments != "" {
			return true
		}
		for _, call := range d.ToolCalls {
			if call.Function.Arguments != "" {
				return true
			}
		}
	}
	return false
}

// Keep only the event awaiting its SSE delimiter, and stop parsing after the
// first generated delta. Oversized/unrecognized events leave the value unknown.
type firstTokenObserver struct {
	At           time.Time
	line, data   []byte
	dropping     bool
	lineNonEmpty bool
}

func (o *firstTokenObserver) Write(payload []byte, at time.Time) {
	const limit = 1 << 20
	if o == nil || !o.At.IsZero() {
		return
	}
	for _, value := range payload {
		if value != '\n' {
			if value != '\r' {
				o.lineNonEmpty = true
			}
			if len(o.line)+len(o.data) >= limit {
				o.dropping = true
				o.line = nil
				o.data = nil
			}
			if !o.dropping {
				o.line = append(o.line, value)
			}
			continue
		}
		line := bytes.TrimSuffix(o.line, []byte{'\r'})
		if !o.lineNonEmpty {
			if !o.dropping && hasGeneratedDelta(o.data) {
				o.At = at
				o.line = nil
				o.data = nil
				return
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
