package dataplane

import (
	"bytes"
	"encoding/json"
)

// executorStreamFramer restores the HTTP-handler framing which CPA deliberately
// keeps outside ProviderExecutor. Relay embeds the executors directly, so it
// must apply the same wire framing before sending chunks to API clients.
type executorStreamFramer interface {
	Push([]byte) []byte
	Flush() []byte
}

type openAIChatSSEFramer struct{}

func (*openAIChatSSEFramer) Push(chunk []byte) []byte {
	if len(chunk) == 0 {
		return nil
	}
	out := make([]byte, 0, len(chunk)+8)
	out = append(out, "data: "...)
	out = append(out, chunk...)
	out = append(out, '\n', '\n')
	return out
}

func (*openAIChatSSEFramer) Flush() []byte { return []byte("data: [DONE]\n\n") }

// responsesSSEFramer is adapted from CPA's OpenAI Responses HTTP handler. CPA
// executors may emit event and data fields as separate chunks, without line or
// frame delimiters. Holding only the partial current frame keeps TTFT low while
// ensuring clients and Relay's usage parser receive valid SSE.
type responsesSSEFramer struct {
	pending []byte
}

func (f *responsesSSEFramer) Push(chunk []byte) []byte {
	if len(chunk) == 0 {
		return nil
	}
	if responsesSSENeedsLineBreak(f.pending, chunk) {
		f.pending = append(f.pending, '\n')
	}
	f.pending = append(f.pending, chunk...)

	var out bytes.Buffer
	for {
		frameLen := responsesSSEFrameLen(f.pending)
		if frameLen == 0 {
			break
		}
		writeResponsesSSEChunk(&out, f.pending[:frameLen])
		copy(f.pending, f.pending[frameLen:])
		f.pending = f.pending[:len(f.pending)-frameLen]
	}
	if len(bytes.TrimSpace(f.pending)) == 0 {
		f.pending = f.pending[:0]
		return out.Bytes()
	}
	if responsesSSECanEmitWithoutDelimiter(f.pending) {
		writeResponsesSSEChunk(&out, f.pending)
		f.pending = f.pending[:0]
	}
	return out.Bytes()
}

func (f *responsesSSEFramer) Flush() []byte {
	if len(f.pending) == 0 || len(bytes.TrimSpace(f.pending)) == 0 {
		f.pending = f.pending[:0]
		return nil
	}
	if !responsesSSECanEmitWithoutDelimiter(f.pending) {
		f.pending = f.pending[:0]
		return nil
	}
	var out bytes.Buffer
	writeResponsesSSEChunk(&out, f.pending)
	f.pending = f.pending[:0]
	return out.Bytes()
}

func writeResponsesSSEChunk(out *bytes.Buffer, chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	out.Write(chunk)
	if bytes.HasSuffix(chunk, []byte("\n\n")) || bytes.HasSuffix(chunk, []byte("\r\n\r\n")) {
		return
	}
	if bytes.HasSuffix(chunk, []byte("\r\n")) || bytes.HasSuffix(chunk, []byte("\n")) {
		out.WriteByte('\n')
		return
	}
	out.WriteString("\n\n")
}

func responsesSSEFrameLen(chunk []byte) int {
	lf := bytes.Index(chunk, []byte("\n\n"))
	crlf := bytes.Index(chunk, []byte("\r\n\r\n"))
	switch {
	case lf < 0:
		if crlf < 0 {
			return 0
		}
		return crlf + 4
	case crlf < 0 || lf < crlf:
		return lf + 2
	default:
		return crlf + 4
	}
}

func responsesSSECanEmitWithoutDelimiter(chunk []byte) bool {
	trimmed := bytes.TrimSpace(chunk)
	if len(trimmed) == 0 || responsesSSENeedsMoreData(trimmed) || !responsesSSEHasField(trimmed, []byte("data:")) {
		return false
	}
	for len(trimmed) > 0 {
		line := trimmed
		if index := bytes.IndexByte(trimmed, '\n'); index >= 0 {
			line, trimmed = trimmed[:index], trimmed[index+1:]
		} else {
			trimmed = nil
		}
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		data := bytes.TrimSpace(line[len("data:"):])
		if len(data) > 0 && !bytes.Equal(data, []byte("[DONE]")) && !json.Valid(data) {
			return false
		}
	}
	return true
}

func responsesSSENeedsMoreData(chunk []byte) bool {
	return responsesSSEHasField(chunk, []byte("event:")) && !responsesSSEHasField(chunk, []byte("data:"))
}

func responsesSSEHasField(chunk, prefix []byte) bool {
	for len(chunk) > 0 {
		line := chunk
		if index := bytes.IndexByte(chunk, '\n'); index >= 0 {
			line, chunk = chunk[:index], chunk[index+1:]
		} else {
			chunk = nil
		}
		if bytes.HasPrefix(bytes.TrimSpace(line), prefix) {
			return true
		}
	}
	return false
}

func responsesSSENeedsLineBreak(pending, chunk []byte) bool {
	if len(pending) == 0 || len(chunk) == 0 || bytes.HasSuffix(pending, []byte("\n")) || bytes.HasSuffix(pending, []byte("\r")) || chunk[0] == '\n' || chunk[0] == '\r' {
		return false
	}
	trimmed := bytes.TrimLeft(chunk, " \t")
	for _, prefix := range [][]byte{[]byte("data:"), []byte("event:"), []byte("id:"), []byte("retry:"), []byte(":")} {
		if bytes.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}
