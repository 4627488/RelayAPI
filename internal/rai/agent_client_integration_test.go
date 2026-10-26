package rai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in tests run actual released agents against an isolated local gateway.
// No existing user config, credential, project or paid provider is used.
func TestAgentClientUsesGateway(t *testing.T) {
	testAgentClients(t, false)
}

func TestAgentClientToolRoundTrip(t *testing.T) {
	testAgentClients(t, true)
}

func testAgentClients(t *testing.T, toolRoundTrip bool) {
	for _, agent := range []string{"pi", "opencode", "grok", "claude", "prime-agent", "hermes"} {
		t.Run(agent, func(t *testing.T) {
			variable := "RAI_" + strings.ToUpper(strings.ReplaceAll(agent, "-", "_")) + "_INTEROP_BINARY"
			binary := os.Getenv(variable)
			if binary == "" {
				t.Skip(variable + " is not configured")
			}
			binary, err := filepath.Abs(binary)
			if err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			var toolSent, toolReturned atomic.Bool
			home := t.TempDir()
			fixture := filepath.Join(home, "fixture.txt")
			if err := os.WriteFile(fixture, []byte("RAI_TOOL_FIXTURE"), 0600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if r.Header.Get("Authorization") != "Bearer rai_local_test" && r.Header.Get("X-API-Key") != "rai_local_test" {
					if r.Method != http.MethodGet && r.Method != http.MethodHead {
						t.Errorf("client did not use rai credentials on %s", r.URL.Path)
					}
					http.Error(w, "unauthorized", 401)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if r.Method == "GET" && r.URL.Path == "/v1/models" {
					io.WriteString(w, `{"object":"list","data":[{"id":"custom-model","name":"Custom model","context_length":131072,"max_output_tokens":4096}]}`)
					return
				}
				if r.URL.Path == "/v1/messages/count_tokens" {
					io.WriteString(w, `{"input_tokens":20}`)
					return
				}
				if r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/v1/messages" && r.URL.Path != "/v1/responses" {
					if r.Method != http.MethodGet && r.Method != http.MethodHead {
						t.Errorf("unexpected inference path %s", r.URL.Path)
					}
					http.NotFound(w, r)
					return
				}
				var body struct {
					Model               string            `json:"model"`
					Stream              bool              `json:"stream"`
					Input               json.RawMessage   `json:"input"`
					Messages            json.RawMessage   `json:"messages"`
					Tools               []json.RawMessage `json:"tools"`
					MaxTokens           int               `json:"max_tokens"`
					MaxCompletionTokens int               `json:"max_completion_tokens"`
					MaxOutputTokens     int               `json:"max_output_tokens"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					http.Error(w, "bad request", 400)
					return
				}
				if body.Model != "custom-model" {
					t.Errorf("model = %q, input %.400s, messages %.400s", body.Model, body.Input, body.Messages)
				}
				if max(body.MaxTokens, body.MaxCompletionTokens, body.MaxOutputTokens) > 4096 {
					t.Errorf("client exceeded advertised output budget: max_tokens=%d max_completion_tokens=%d max_output_tokens=%d", body.MaxTokens, body.MaxCompletionTokens, body.MaxOutputTokens)
				}
				requests.Add(1)
				if toolRoundTrip && len(body.Tools) > 0 {
					conversation := string(body.Messages) + string(body.Input)
					if strings.Contains(conversation, "RAI_TOOL_FIXTURE") {
						toolReturned.Store(true)
					}
					if !toolSent.Load() {
						name, args, err := fixtureReadTool(body.Tools, fixture)
						if err != nil && !strings.Contains(string(body.Tools[0]), "session_title") {
							t.Error(err)
							http.Error(w, "no compatible read tool", 400)
							return
						}
						if err == nil {
							toolSent.Store(true)
							writeAgentToolCall(w, r.URL.Path, body.Stream, name, args)
							return
						}
					} else if !toolReturned.Load() {
						if len(conversation) > 2200 {
							conversation = conversation[len(conversation)-2200:]
						}
						t.Logf("tool continuation %s", conversation)
					}
				}
				if r.URL.Path == "/v1/responses" {
					writeAgentTestResponse(w, body.Stream)
					return
				}
				if r.URL.Path == "/v1/messages" {
					if !body.Stream {
						io.WriteString(w, `{"id":"msg_test","type":"message","role":"assistant","model":"custom-model","content":[{"type":"text","text":"RAI_INTEROP_OK"}],"stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":5}}`)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"custom-model\",\"content\":[],\"usage\":{\"input_tokens\":20,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"RAI_INTEROP_OK\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
					return
				}
				if !body.Stream {
					io.WriteString(w, `{"id":"chat_test","object":"chat.completion","model":"custom-model","choices":[{"index":0,"message":{"role":"assistant","content":"RAI_INTEROP_OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, chunk := range []string{
					`{"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{"role":"assistant","content":"RAI_INTEROP_OK"},"finish_reason":null}]}`,
					`{"id":"chat_test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}`, "[DONE]",
				} {
					fmt.Fprintf(w, "data: %s\n\n", chunk)
				}
			}))
			defer server.Close()
			env := mergeEnv([]string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8", "TERM=dumb"}, map[string]string{
				"HOME": home, "USERPROFILE": home, "XDG_CONFIG_HOME": filepath.Join(home, "config"), "XDG_DATA_HOME": filepath.Join(home, "data"), "XDG_CACHE_HOME": filepath.Join(home, "cache"),
				"PI_CODING_AGENT_DIR": filepath.Join(home, "pi"), "HERMES_HOME": filepath.Join(home, "hermes"), "PRIME_AGENT_CODING_AGENT_DIR": filepath.Join(home, "prime"),
				"GROK_HOME": filepath.Join(home, "grok"), "CLAUDE_CONFIG_DIR": filepath.Join(home, "claude"), "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_AUTOUPDATE": "true",
				"ANTHROPIC_AUTH_TOKEN": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "", "OPENROUTER_API_KEY": "", "NO_COLOR": "1", "PI_OFFLINE": "1",
			})
			prompt := "Reply RAI_INTEROP_OK. Do not use tools."
			if toolRoundTrip {
				prompt = "Read " + fixture + " using your file or Python tool, then reply RAI_INTEROP_OK."
			}
			args := []string{"--print", prompt}
			switch agent {
			case "pi":
				args = []string{"--no-session", "--print", prompt}
			case "prime-agent":
				args = []string{"--offline", "--no-session", "--print", prompt}
			case "hermes":
				args = []string{"-z", prompt}
			case "opencode":
				args = []string{"run", "--format", "json", prompt}
			case "grok", "claude":
				args = []string{"-p", prompt}
			}
			adapter, _ := AdapterByName(agent)
			command, err := adapter.Prepare(LaunchContext{Profile: Profile{Name: "test", ServerURL: server.URL, OpenCodeProtocol: "chat"}, APIBase: server.URL, APIKey: "rai_local_test", Model: "custom-model", Models: []string{"custom-model"}, ModelInfo: map[string]ModelInfo{"custom-model": {Context: 131072, MaxOutput: 4096, ToolCall: boolValue(true), InputModalities: []string{"text"}}}, Executable: binary, Args: args, Environ: env, RuntimeDir: t.TempDir(), RAIHome: home})
			if err != nil {
				t.Fatal(err)
			}
			if agent == "hermes" {
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					stop := exec.CommandContext(ctx, binary, "gateway", "stop")
					stop.Env = env
					_ = stop.Run()
				})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, command.Path, command.Args...)
			cmd.WaitDelay = 5 * time.Second
			cmd.Env, cmd.Dir = command.Env, home
			out, err := cmd.CombinedOutput()
			if err != nil {
				if agent == "hermes" {
					filepath.WalkDir(filepath.Join(home, "hermes", "logs"), func(path string, entry os.DirEntry, err error) error {
						if err == nil && !entry.IsDir() && strings.HasSuffix(path, ".log") {
							raw, _ := os.ReadFile(path)
							if len(raw) > 5000 {
								raw = raw[len(raw)-5000:]
							}
							t.Logf("%s:\n%s", entry.Name(), raw)
						}
						return nil
					})
				}
				t.Fatalf("real %s failed: %v\n%s", agent, err, out)
			}
			if requests.Load() == 0 || !strings.Contains(string(out), "RAI_INTEROP_OK") {
				t.Fatalf("no confirmed gateway completion (%d requests):\n%s", requests.Load(), out)
			}
			if toolRoundTrip && (!toolSent.Load() || !toolReturned.Load()) {
				t.Fatalf("tool round trip incomplete (sent=%v returned=%v):\n%s", toolSent.Load(), toolReturned.Load(), out)
			}
		})
	}
}

func fixtureReadTool(tools []json.RawMessage, fixture string) (string, map[string]any, error) {
	var names []string
	for _, raw := range tools {
		var tool struct {
			Name        string `json:"name"`
			InputSchema struct {
				Properties map[string]any `json:"properties"`
			} `json:"input_schema"`
			Function struct {
				Name       string `json:"name"`
				Parameters struct {
					Properties map[string]any `json:"properties"`
				} `json:"parameters"`
			} `json:"function"`
			Parameters struct {
				Properties map[string]any `json:"properties"`
			} `json:"parameters"`
		}
		if err := json.Unmarshal(raw, &tool); err != nil {
			return "", nil, err
		}
		name, props := tool.Name, tool.InputSchema.Properties
		if tool.Function.Name != "" {
			name, props = tool.Function.Name, tool.Function.Parameters.Properties
		}
		if props == nil {
			props = tool.Parameters.Properties
		}
		names = append(names, name)
		lower := strings.ToLower(name)
		if lower == "read" || lower == "read_file" || lower == "readfile" {
			for _, key := range []string{"path", "file_path", "filePath", "target_file"} {
				if _, ok := props[key]; ok {
					return name, map[string]any{key: fixture}, nil
				}
			}
		}
		if lower == "python" || lower == "python_repl" {
			for _, key := range []string{"code", "source"} {
				if _, ok := props[key]; ok {
					path, _ := json.Marshal(fixture)
					return name, map[string]any{key: "print(open(" + string(path) + ").read())"}, nil
				}
			}
		}
	}
	return "", nil, fmt.Errorf("no fixture read tool among %v", names)
}

func writeAgentToolCall(w http.ResponseWriter, path string, stream bool, name string, arguments map[string]any) {
	args, _ := json.Marshal(arguments)
	if path == "/v1/responses" {
		item := map[string]any{"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture", "name": name, "arguments": string(args), "status": "completed"}
		response := map[string]any{"id": "resp_tool", "object": "response", "status": "completed", "model": "custom-model", "output": []any{item}, "usage": map[string]int{"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}}
		if !stream {
			_ = json.NewEncoder(w).Encode(response)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for i, event := range []map[string]any{
			{"type": "response.created", "response": map[string]any{"id": "resp_tool", "object": "response", "status": "in_progress", "output": []any{}}},
			{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture", "name": name, "arguments": "", "status": "in_progress"}},
			{"type": "response.function_call_arguments.delta", "output_index": 0, "item_id": "fc_fixture", "delta": string(args)},
			{"type": "response.function_call_arguments.done", "output_index": 0, "item_id": "fc_fixture", "arguments": string(args)},
			{"type": "response.output_item.done", "output_index": 0, "item": item},
			{"type": "response.completed", "response": response},
		} {
			event["sequence_number"] = i
			raw, _ := json.Marshal(event)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], raw)
		}
		return
	}
	if path == "/v1/messages" {
		block := map[string]any{"type": "tool_use", "id": "call_fixture", "name": name, "input": arguments}
		message := map[string]any{"id": "msg_tool", "type": "message", "role": "assistant", "model": "custom-model", "content": []any{block}, "stop_reason": "tool_use", "usage": map[string]int{"input_tokens": 20, "output_tokens": 5}}
		if !stream {
			_ = json.NewEncoder(w).Encode(message)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range []map[string]any{
			{"type": "message_start", "message": map[string]any{"id": "msg_tool", "type": "message", "role": "assistant", "model": "custom-model", "content": []any{}, "usage": map[string]int{"input_tokens": 20, "output_tokens": 0}}},
			{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "call_fixture", "name": name, "input": map[string]any{}}},
			{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(args)}},
			{"type": "content_block_stop", "index": 0},
			{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]int{"output_tokens": 5}},
			{"type": "message_stop"},
		} {
			raw, _ := json.Marshal(event)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], raw)
		}
		return
	}
	call := map[string]any{"id": "call_fixture", "type": "function", "function": map[string]any{"name": name, "arguments": string(args)}}
	if !stream {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "chat_tool", "object": "chat.completion", "model": "custom-model", "choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{call}}, "finish_reason": "tool_calls"}}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	call["index"] = 0
	for _, choice := range []any{
		map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{call}}, "finish_reason": nil},
		map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"},
	} {
		raw, _ := json.Marshal(map[string]any{"id": "chat_tool", "object": "chat.completion.chunk", "created": 1, "model": "custom-model", "choices": []any{choice}})
		fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	io.WriteString(w, "data: [DONE]\n\n")
}

func writeAgentTestResponse(w http.ResponseWriter, stream bool) {
	message := map[string]any{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "RAI_INTEROP_OK", "annotations": []any{}}}}
	response := map[string]any{"id": "resp_test", "object": "response", "status": "completed", "model": "custom-model", "output": []any{message}, "usage": map[string]int{"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}}
	if !stream {
		_ = json.NewEncoder(w).Encode(response)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	for i, event := range []map[string]any{
		{"type": "response.created", "response": map[string]any{"id": "resp_test", "object": "response", "status": "in_progress", "output": []any{}}},
		{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"id": "msg_test", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}},
		{"type": "response.content_part.added", "output_index": 0, "item_id": "msg_test", "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}},
		{"type": "response.output_text.delta", "output_index": 0, "item_id": "msg_test", "content_index": 0, "delta": "RAI_INTEROP_OK"},
		{"type": "response.output_text.done", "output_index": 0, "item_id": "msg_test", "content_index": 0, "text": "RAI_INTEROP_OK"},
		{"type": "response.output_item.done", "output_index": 0, "item": message},
		{"type": "response.completed", "response": response},
	} {
		event["sequence_number"] = i
		raw, _ := json.Marshal(event)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], raw)
	}
}
