package relaybridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

// codexInteropExecutor contains narrowly-scoped compatibility repairs that
// belong at the provider boundary. CPA's xAI executor intentionally removes
// Codex's freeform apply_patch tool. Relay instead lowers that declaration to
// an ordinary string-input function and restores the Responses freeform shape
// on the way back. The wrapped CPA executor remains responsible for transport,
// auth, retries, namespace handling and protocol translation.
type codexInteropExecutor struct {
	inner cliproxyauth.ProviderExecutor
}

func newCodexInteropExecutor(inner cliproxyauth.ProviderExecutor) cliproxyauth.ProviderExecutor {
	return &codexInteropExecutor{inner: inner}
}

func (e *codexInteropExecutor) Identifier() string { return e.inner.Identifier() }

func (e *codexInteropExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	req, opts, refs := lowerApplyPatchRequest(req, opts)
	response, err := e.inner.Execute(ctx, auth, req, opts)
	if err == nil && len(refs) > 0 {
		restore := newApplyPatchResponseRestorer(refs)
		response.Payload = restore.restore(response.Payload)
	}
	return response, err
}

func (e *codexInteropExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	req, opts, refs := lowerApplyPatchRequest(req, opts)
	result, err := e.inner.ExecuteStream(ctx, auth, req, opts)
	if err != nil || result == nil || len(refs) == 0 {
		return result, err
	}
	restore := newApplyPatchResponseRestorer(refs)
	chunks := make(chan cliproxyexecutor.StreamChunk)
	go func() {
		defer close(chunks)
		for chunk := range result.Chunks {
			if chunk.Err == nil {
				chunk.Payload = restore.restore(chunk.Payload)
				if len(chunk.Payload) == 0 {
					continue
				}
			}
			select {
			case chunks <- chunk:
			case <-ctx.Done():
				return
			}
		}
	}()
	return &cliproxyexecutor.StreamResult{Headers: result.Headers, Chunks: chunks}, nil
}

func (e *codexInteropExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	return e.inner.Refresh(ctx, auth)
}

func (e *codexInteropExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return e.inner.CountTokens(ctx, auth, req, opts)
}

func (e *codexInteropExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	return e.inner.HttpRequest(ctx, auth, req)
}

func (e *codexInteropExecutor) PrepareRequest(req *http.Request, auth *cliproxyauth.Auth) error {
	if preparer, ok := e.inner.(interface {
		PrepareRequest(*http.Request, *cliproxyauth.Auth) error
	}); ok {
		return preparer.PrepareRequest(req, auth)
	}
	return nil
}

func (e *codexInteropExecutor) CloseExecutionSession(sessionID string) {
	if closer, ok := e.inner.(interface{ CloseExecutionSession(string) }); ok {
		closer.CloseExecutionSession(sessionID)
	}
}

func (e *codexInteropExecutor) UpstreamDisconnectChan(sessionID string) <-chan error {
	if subscriber, ok := e.inner.(interface{ UpstreamDisconnectChan(string) <-chan error }); ok {
		return subscriber.UpstreamDisconnectChan(sessionID)
	}
	return nil
}

type applyPatchToolRef struct {
	name      string
	namespace string
}

func lowerApplyPatchRequest(req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Request, cliproxyexecutor.Options, []applyPatchToolRef) {
	var refs []applyPatchToolRef
	req.Payload, refs = lowerApplyPatchJSON(req.Payload, refs)
	opts.OriginalRequest, refs = lowerApplyPatchJSON(opts.OriginalRequest, refs)
	return req, opts, uniqueApplyPatchRefs(refs)
}

func lowerApplyPatchJSON(payload []byte, refs []applyPatchToolRef) ([]byte, []applyPatchToolRef) {
	if len(payload) == 0 {
		return payload, refs
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return payload, refs
	}
	changed := false
	var lowerTools func(value any, namespace string)
	lowerTools = func(value any, namespace string) {
		tools, ok := value.([]any)
		if !ok {
			return
		}
		for _, value := range tools {
			tool, ok := value.(map[string]any)
			if !ok {
				continue
			}
			toolType, _ := tool["type"].(string)
			if toolType == "namespace" {
				childNamespace, _ := tool["name"].(string)
				lowerTools(tool["tools"], strings.TrimSpace(childNamespace))
				continue
			}
			name, _ := tool["name"].(string)
			if toolType != "custom" || strings.TrimSpace(name) != "apply_patch" {
				continue
			}
			tool["type"] = "function"
			tool["parameters"] = map[string]any{
				"type":       "object",
				"properties": map[string]any{"input": map[string]any{"type": "string"}},
				"required":   []any{"input"},
			}
			delete(tool, "format")
			refs = append(refs, applyPatchToolRef{name: "apply_patch", namespace: namespace})
			changed = true
		}
	}
	lowerTools(root["tools"], "")
	if input, ok := root["input"].([]any); ok {
		for _, value := range input {
			item, ok := value.(map[string]any)
			if ok && item["type"] == "additional_tools" {
				lowerTools(item["tools"], "")
			}
		}
	}
	lowerApplyPatchToolChoice(root["tool_choice"])
	if !changed {
		return payload, refs
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload, refs
	}
	return encoded, refs
}

func lowerApplyPatchToolChoice(value any) {
	choice, ok := value.(map[string]any)
	if !ok {
		return
	}
	if choice["type"] == "custom" && choice["name"] == "apply_patch" {
		choice["type"] = "function"
	}
	if tools, ok := choice["tools"].([]any); ok {
		for _, tool := range tools {
			lowerApplyPatchToolChoice(tool)
		}
	}
}

func uniqueApplyPatchRefs(refs []applyPatchToolRef) []applyPatchToolRef {
	seen := make(map[applyPatchToolRef]struct{}, len(refs))
	result := make([]applyPatchToolRef, 0, len(refs))
	for _, ref := range refs {
		if _, ok := seen[ref]; ok {
			continue
		}
		seen[ref] = struct{}{}
		result = append(result, ref)
	}
	return result
}

type applyPatchResponseRestorer struct {
	refs       map[applyPatchToolRef]struct{}
	itemIDs    map[string]struct{}
	outputKeys map[string]struct{}
}

func newApplyPatchResponseRestorer(refs []applyPatchToolRef) *applyPatchResponseRestorer {
	result := &applyPatchResponseRestorer{
		refs: make(map[applyPatchToolRef]struct{}, len(refs)), itemIDs: make(map[string]struct{}), outputKeys: make(map[string]struct{}),
	}
	for _, ref := range refs {
		result.refs[ref] = struct{}{}
	}
	return result
}

func (r *applyPatchResponseRestorer) restore(payload []byte) []byte {
	if len(payload) == 0 {
		return payload
	}
	prefix, data, suffix := splitSSEData(payload)
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return payload
	}
	eventType, _ := root["type"].(string)
	switch eventType {
	case "response.function_call_arguments.delta":
		if r.isTrackedEvent(root) {
			return nil
		}
	case "response.function_call_arguments.done":
		if r.isTrackedEvent(root) {
			root["type"] = "response.custom_tool_call_input.done"
			root["input"] = unwrapApplyPatchInput(root["arguments"])
			delete(root, "arguments")
		}
	}
	for _, key := range []string{"item"} {
		if item, ok := root[key].(map[string]any); ok {
			r.restoreItem(item, root)
		}
	}
	for _, path := range []string{"output"} {
		r.restoreItems(root[path], nil)
	}
	if response, ok := root["response"].(map[string]any); ok {
		r.restoreItems(response["output"], nil)
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	restored := make([]byte, 0, len(prefix)+len(encoded)+len(suffix))
	restored = append(restored, prefix...)
	restored = append(restored, encoded...)
	return append(restored, suffix...)
}

func (r *applyPatchResponseRestorer) restoreItems(value any, event map[string]any) {
	items, ok := value.([]any)
	if !ok {
		return
	}
	for _, value := range items {
		if item, ok := value.(map[string]any); ok {
			r.restoreItem(item, event)
		}
	}
}

func (r *applyPatchResponseRestorer) restoreItem(item, event map[string]any) {
	if item["type"] != "function_call" || !r.isApplyPatchItem(item) {
		return
	}
	item["type"] = "custom_tool_call"
	if arguments, ok := item["arguments"]; ok {
		item["input"] = unwrapApplyPatchInput(arguments)
		delete(item, "arguments")
	}
	if id, ok := item["id"].(string); ok && id != "" {
		r.itemIDs[id] = struct{}{}
	}
	if event != nil {
		if index, ok := event["output_index"]; ok {
			r.outputKeys[indexKey(index)] = struct{}{}
		}
	}
}

func (r *applyPatchResponseRestorer) isApplyPatchItem(item map[string]any) bool {
	name, _ := item["name"].(string)
	namespace, _ := item["namespace"].(string)
	_, ok := r.refs[applyPatchToolRef{name: strings.TrimSpace(name), namespace: strings.TrimSpace(namespace)}]
	return ok
}

func (r *applyPatchResponseRestorer) isTrackedEvent(event map[string]any) bool {
	if id, ok := event["item_id"].(string); ok {
		if _, tracked := r.itemIDs[id]; tracked {
			return true
		}
	}
	if index, ok := event["output_index"]; ok {
		_, tracked := r.outputKeys[indexKey(index)]
		return tracked
	}
	return false
}

func unwrapApplyPatchInput(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	var object map[string]any
	if json.Unmarshal([]byte(text), &object) == nil {
		if input, exists := object["input"]; exists {
			return input
		}
	}
	return text
}

func splitSSEData(payload []byte) (prefix, data, suffix []byte) {
	trimmed := bytes.TrimSpace(payload)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil, payload, nil
	}
	index := bytes.Index(payload, []byte("data:"))
	dataStart := index + len("data:")
	for dataStart < len(payload) && (payload[dataStart] == ' ' || payload[dataStart] == '\t') {
		dataStart++
	}
	dataEnd := len(payload)
	for dataEnd > dataStart && (payload[dataEnd-1] == '\r' || payload[dataEnd-1] == '\n' || payload[dataEnd-1] == ' ' || payload[dataEnd-1] == '\t') {
		dataEnd--
	}
	return append([]byte(nil), payload[:dataStart]...), payload[dataStart:dataEnd], append([]byte(nil), payload[dataEnd:]...)
}

func indexKey(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

var _ cliproxyauth.ProviderExecutor = (*codexInteropExecutor)(nil)
