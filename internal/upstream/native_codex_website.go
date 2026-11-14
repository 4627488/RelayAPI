package upstream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// prepareCodexWebsiteRequest rewrites a Responses body for ChatGPT's Codex
// website backend. That endpoint is not OpenAI-compatible: input must be a
// list, store must be false, stream must be true, and max_output_tokens is
// rejected. When the client asked for a non-stream reply, CollectStream tells
// the caller to collapse the upstream SSE into one JSON Responses object.
func prepareCodexWebsiteRequest(body []byte) (codexWebsiteAdaptation, error) {
	if !gjson.ValidBytes(body) {
		return codexWebsiteAdaptation{}, fmt.Errorf("invalid Responses request: expected a JSON object")
	}
	root := gjson.ParseBytes(body)
	if !root.IsObject() {
		return codexWebsiteAdaptation{}, fmt.Errorf("invalid Responses request: expected a JSON object")
	}
	clientStream := root.Get("stream").Type == gjson.True
	// Patch only the backend's required fields. Decoding the entire context
	// into map[string]any allocated thousands of objects on every tool turn
	// and rounded opaque integers through float64. Already-normalized client
	// requests now pass through without rebuilding their input/tools trees.
	encoded := body
	set := func(path string, value []byte) error {
		var err error
		encoded, err = sjson.SetRawBytes(encoded, path, value)
		return err
	}
	if input := root.Get("input"); input.Type == gjson.String {
		wrapped := []byte(`[{"role":"user","content":[{"type":"input_text","text":` + input.Raw + `}]}]`)
		if err := set("input", wrapped); err != nil {
			return codexWebsiteAdaptation{}, err
		}
	}
	if root.Get("store").Type != gjson.False {
		if err := set("store", []byte("false")); err != nil {
			return codexWebsiteAdaptation{}, err
		}
	}
	if !clientStream {
		if err := set("stream", []byte("true")); err != nil {
			return codexWebsiteAdaptation{}, err
		}
	}
	for _, field := range []string{"max_output_tokens", "max_tokens"} {
		if root.Get(field).Exists() {
			var err error
			encoded, err = sjson.DeleteBytes(encoded, field)
			if err != nil {
				return codexWebsiteAdaptation{}, err
			}
		}
	}
	return codexWebsiteAdaptation{Body: encoded, CollectStream: !clientStream}, nil
}

type codexWebsiteAdaptation struct {
	Body          []byte
	CollectStream bool
}

func collectResponsesSSE(r io.Reader) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(r, maxProviderResponseBytes))
	if err != nil {
		return nil, err
	}
	if completed := completedResponseFromPayload(payload); len(completed) > 0 {
		return completed, nil
	}
	if errPayload := firstSSEError(payload); len(errPayload) > 0 {
		return errPayload, fmt.Errorf("upstream stream error")
	}
	return nil, fmt.Errorf("upstream stream ended without a completed response")
}

func completedResponseFromPayload(payload []byte) []byte {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var root map[string]any
		if json.Unmarshal(trimmed, &root) == nil {
			if encoded := encodeCompletedResponse(root); len(encoded) > 0 {
				return encoded
			}
		}
	}
	var latest []byte
	for _, data := range sseDataPayloads(payload) {
		var root map[string]any
		if json.Unmarshal(data, &root) != nil {
			continue
		}
		if encoded := encodeCompletedResponse(root); len(encoded) > 0 {
			latest = encoded
		}
	}
	return latest
}

func encodeCompletedResponse(root map[string]any) []byte {
	switch anyString(root["type"]) {
	case "response.completed", "response.incomplete":
		if response, ok := root["response"].(map[string]any); ok {
			encoded, err := json.Marshal(response)
			if err == nil {
				return encoded
			}
		}
	}
	if anyString(root["object"]) == "response" || root["output"] != nil {
		encoded, err := json.Marshal(root)
		if err == nil {
			return encoded
		}
	}
	return nil
}

func firstSSEError(payload []byte) []byte {
	for _, data := range sseDataPayloads(payload) {
		var root map[string]any
		if json.Unmarshal(data, &root) != nil {
			continue
		}
		if anyString(root["type"]) == "error" || root["error"] != nil || root["detail"] != nil {
			return append([]byte(nil), data...)
		}
	}
	return nil
}

func sseDataPayloads(payload []byte) [][]byte {
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	chunks := make([][]byte, 0)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		chunks = append(chunks, []byte(data))
	}
	return chunks
}
