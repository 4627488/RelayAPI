package relaybridge

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func TestLowerApplyPatchRequestCoversTopLevelAdditionalAndNamespaceTools(t *testing.T) {
	raw := []byte(`{
		"tools":[
			{"type":"custom","name":"apply_patch","format":{"type":"grammar"}},
			{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}
		],
		"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}],
		"tool_choice":{"type":"custom","name":"apply_patch"}
	}`)
	request, options, refs := lowerApplyPatchRequest(
		cliproxyexecutor.Request{Payload: raw},
		cliproxyexecutor.Options{OriginalRequest: raw},
	)
	if len(refs) != 2 {
		t.Fatalf("refs = %#v, want top-level and editor namespace", refs)
	}
	for label, payload := range map[string][]byte{"payload": request.Payload, "original": options.OriginalRequest} {
		var root map[string]any
		if err := json.Unmarshal(payload, &root); err != nil {
			t.Fatalf("%s is invalid JSON: %v", label, err)
		}
		tools := root["tools"].([]any)
		first := tools[0].(map[string]any)
		if first["type"] != "function" || first["format"] != nil {
			t.Fatalf("%s top-level tool was not lowered: %#v", label, first)
		}
		parameters := first["parameters"].(map[string]any)
		if parameters["type"] != "object" {
			t.Fatalf("%s parameters = %#v", label, parameters)
		}
		choice := root["tool_choice"].(map[string]any)
		if choice["type"] != "function" {
			t.Fatalf("%s tool choice = %#v", label, choice)
		}
	}
}

func TestApplyPatchResponseRestorerPreservesResponsesSemantics(t *testing.T) {
	restore := newApplyPatchResponseRestorer([]applyPatchToolRef{{name: "apply_patch"}})
	added := restore.restore([]byte(`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call_1","arguments":""}}\n\n`))
	assertJSONPath(t, added, "item.type", "custom_tool_call")
	if got := string(restore.restore([]byte(`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\\"input\\\":"}`))); got != "" {
		t.Fatalf("function argument delta was not suppressed: %s", got)
	}
	done := restore.restore([]byte(`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}"}`))
	assertJSONPath(t, done, "type", "response.custom_tool_call_input.done")
	assertJSONPath(t, done, "input", "*** Begin Patch\n*** End Patch")
	completed := restore.restore([]byte(`{"type":"response.completed","response":{"output":[{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call_1","arguments":"{\"input\":\"patch\"}"}]}}`))
	assertJSONPath(t, completed, "response.output.0.type", "custom_tool_call")
	assertJSONPath(t, completed, "response.output.0.input", "patch")
}

func TestCodexInteropExecutorTransformsStreamingChunks(t *testing.T) {
	inner := &interopFakeExecutor{}
	executor := newCodexInteropExecutor(inner)
	raw := []byte(`{"tools":[{"type":"custom","name":"apply_patch"}]}`)
	result, err := executor.ExecuteStream(context.Background(), nil, cliproxyexecutor.Request{Payload: raw}, cliproxyexecutor.Options{OriginalRequest: raw})
	if err != nil {
		t.Fatal(err)
	}
	var chunks [][]byte
	for chunk := range result.Chunks {
		chunks = append(chunks, chunk.Payload)
	}
	if len(chunks) != 3 {
		t.Fatalf("chunk count = %d, want 3 (delta suppressed)", len(chunks))
	}
	assertJSONPath(t, chunks[0], "item.type", "custom_tool_call")
	assertJSONPath(t, chunks[1], "type", "response.custom_tool_call_input.done")
	assertJSONPath(t, chunks[2], "response.output.0.type", "custom_tool_call")
}

func assertJSONPath(t *testing.T, payload []byte, path, want string) {
	t.Helper()
	if len(payload) >= 6 && string(payload[:6]) == "data: " {
		payload = payload[6:]
	}
	var value any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("invalid JSON %q: %v", payload, err)
	}
	current := value
	for _, part := range splitTestPath(path) {
		switch typed := current.(type) {
		case map[string]any:
			current = typed[part]
		case []any:
			index := int(part[0] - '0')
			current = typed[index]
		default:
			t.Fatalf("path %s stopped at %#v", path, current)
		}
	}
	if current != want {
		t.Fatalf("%s = %#v, want %q; payload=%s", path, current, want, payload)
	}
}

func splitTestPath(path string) []string {
	var result []string
	for len(path) > 0 {
		index := 0
		for index < len(path) && path[index] != '.' {
			index++
		}
		result = append(result, path[:index])
		if index == len(path) {
			break
		}
		path = path[index+1:]
	}
	return result
}

type interopFakeExecutor struct{}

func (*interopFakeExecutor) Identifier() string { return "xai" }
func (*interopFakeExecutor) Execute(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (*interopFakeExecutor) ExecuteStream(_ context.Context, _ *cliproxyauth.Auth, request cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	var root map[string]any
	_ = json.Unmarshal(request.Payload, &root)
	tools := root["tools"].([]any)
	if tools[0].(map[string]any)["type"] != "function" {
		panic("request was not lowered before delegation")
	}
	chunks := make(chan cliproxyexecutor.StreamChunk, 4)
	chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call_1","arguments":""}}`)}
	chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"partial"}`)}
	chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":"{\"input\":\"patch\"}"}`)}
	chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"type":"response.completed","response":{"output":[{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call_1","arguments":"{\"input\":\"patch\"}"}]}}`)}
	close(chunks)
	return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
}
func (*interopFakeExecutor) Refresh(_ context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	return auth, nil
}
func (*interopFakeExecutor) CountTokens(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (*interopFakeExecutor) HttpRequest(context.Context, *cliproxyauth.Auth, *http.Request) (*http.Response, error) {
	return nil, nil
}
