package upstream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// prepareCodexWebsiteRequest rewrites a Responses body for ChatGPT's Codex
// website backend. That endpoint is not OpenAI-compatible: input must be a
// list, store must be false, stream must be true, and max_output_tokens is
// rejected. When the client asked for a non-stream reply, CollectStream tells
// the caller to collapse the upstream SSE into one JSON Responses object.
func prepareCodexWebsiteRequest(body []byte) (codexWebsiteAdaptation, error) {
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return codexWebsiteAdaptation{}, fmt.Errorf("invalid Responses request: %w", err)
	}
	clientStream := false
	if raw, ok := root["stream"]; ok {
		clientStream, _ = raw.(bool)
	}
	rewriteCodexWebsiteFields(root)
	encoded, err := json.Marshal(root)
	if err != nil {
		return codexWebsiteAdaptation{}, err
	}
	return codexWebsiteAdaptation{Body: encoded, CollectStream: !clientStream}, nil
}

type codexWebsiteAdaptation struct {
	Body          []byte
	CollectStream bool
}

func rewriteCodexWebsiteFields(root map[string]any) {
	if root == nil {
		return
	}
	switch input := root["input"].(type) {
	case string:
		root["input"] = []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]any{"type": "input_text", "text": input},
			},
		}}
	}
	root["store"] = false
	delete(root, "max_output_tokens")
	delete(root, "max_tokens")
	root["stream"] = true
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
