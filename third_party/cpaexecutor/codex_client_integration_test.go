package relaybridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tidwall/gjson"
)

// The native client must accept our compaction item and replay it on its next
// turn. This exercises the embedded gateway, not a hand-written Codex fixture.
func TestCodexClientCompactsAndContinuesChat(t *testing.T) {
	binary := os.Getenv("CODEX_INTEROP_BINARY")
	if binary == "" {
		t.Skip("CODEX_INTEROP_BINARY is not configured")
	}
	for _, ws := range []bool{false, true} {
		t.Run("websocket="+strconv.FormatBool(ws), func(t *testing.T) {
			var summaries, continuations atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/v1/chat/completions" || strings.Contains(string(body), "encrypted_content") || strings.Contains(string(body), "compaction_trigger") {
					t.Errorf("unadapted request: %s %s", r.URL, body)
				}
				if !gjson.GetBytes(body, "stream").Bool() {
					summaries.Add(1)
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"id":"summary","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Retained plan: implement the adapter."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`)
					return
				}
				if strings.Contains(string(body), "Retained plan: implement the adapter.") {
					continuations.Add(1)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "data: {\"id\":\"chat_next\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"continued\"},\"finish_reason\":null}]}\n\n")
				io.WriteString(w, "data: {\"id\":\"chat_next\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\ndata: [DONE]\n\n")
			}))
			defer upstream.Close()
			document, _ := json.Marshal(map[string]any{"type": "openai", "api_key": "test", "base_url": upstream.URL + "/v1", "upstream_api": "chat"})
			runtime, err := NewRuntime(Options{APIKey: "internal"}, []Credential{{ID: "chat", Provider: "openai", Enabled: true, Models: []string{"interop-chat"}, Document: document}})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close(context.Background())
			server := httptest.NewServer(runtime.Handler())
			defer server.Close()
			home := t.TempDir()
			ctx, cancel := context.WithTimeout(t.Context(), 35*time.Second)
			defer cancel()
			args := []string{"app-server"}
			for _, override := range []string{
				`model="interop-chat"`, `model_provider="relay_test"`,
				`model_providers.relay_test.name="Relay test"`,
				"model_providers.relay_test.base_url=" + strconv.Quote(server.URL+"/v1"),
				`model_providers.relay_test.wire_api="responses"`,
				`model_providers.relay_test.env_key="RAI_INTEROP_TOKEN"`,
				`model_providers.relay_test.capabilities.remote_compaction="v2"`,
				"model_providers.relay_test.supports_websockets=" + strconv.FormatBool(ws),
			} {
				args = append(args, "-c", override)
			}
			command := exec.CommandContext(ctx, binary, args...)
			command.Env = append(os.Environ(), "CODEX_HOME="+home, "RAI_INTEROP_TOKEN=internal")
			input, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			var stderr, transcript bytes.Buffer
			command.Stderr = &stderr
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); _ = command.Wait() }()
			send := func(id int, method string, params any) {
				if err := json.NewEncoder(input).Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
					t.Fatal(err)
				}
			}
			send(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "relay_test", "version": "1"}})
			var thread string
			stage := 0
			scanner := bufio.NewScanner(stdout)
			scanner.Buffer(make([]byte, 65536), 4<<20)
			for scanner.Scan() {
				line := append([]byte(nil), scanner.Bytes()...)
				transcript.Write(line)
				transcript.WriteByte('\n')
				if gjson.GetBytes(line, "error").Exists() {
					t.Fatalf("app-server: %s", line)
				}
				switch gjson.GetBytes(line, "id").Int() {
				case 1:
					send(2, "thread/start", map[string]any{"model": "interop-chat", "modelProvider": "relay_test", "cwd": home, "sandbox": "read-only"})
				case 2:
					thread = gjson.GetBytes(line, "result.thread.id").String()
					send(3, "turn/start", map[string]any{"threadId": thread, "input": []any{map[string]string{"type": "text", "text": "Remember the plan. Do not use tools."}}})
				}
				if gjson.GetBytes(line, "method").String() == "turn/completed" {
					if stage == 0 {
						stage = 1
						send(4, "thread/compact/start", map[string]string{"threadId": thread})
					} else if stage == 1 {
						stage = 2
						send(5, "turn/start", map[string]any{"threadId": thread, "input": []any{map[string]string{"type": "text", "text": "Continue the retained plan."}}})
					} else {
						stage = 3
						break
					}
				}
			}
			cancel()
			_ = command.Wait()
			if stage != 3 || summaries.Load() != 1 || continuations.Load() < 1 {
				t.Fatalf("stage=%d summaries=%d continuations=%d\n%s\n%s", stage, summaries.Load(), continuations.Load(), transcript.String(), stderr.String())
			}
		})
	}
}
