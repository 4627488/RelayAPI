package relaybridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func TestBuiltinProvidersUseCPAExecutorsAndCatalogs(t *testing.T) {
	for _, provider := range []string{"claude", "gemini", "gemini-interactions", "vertex", "aistudio", "antigravity", "kimi", "xai", "devin", "meta"} {
		t.Run(provider, func(t *testing.T) {
			document, _ := json.Marshal(map[string]any{"type": provider, "api_key": "test-key"})
			runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{ID: provider, Provider: provider, Enabled: true, Document: document}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = runtime.Close(context.Background()) })
			if _, ok := runtime.manager.Executor(provider); !ok {
				t.Fatalf("CPA executor for %s missing", provider)
			}
			want := modelIDs(registry.GetStaticModelDefinitionsByChannel(provider))
			if len(want) == 0 || strings.Join(runtime.CredentialModels(provider), "\n") != strings.Join(want, "\n") {
				t.Fatalf("%s models differ from CPA catalog: %v, want %v", provider, runtime.CredentialModels(provider), want)
			}
		})
	}
}

func TestClaudeMessagesAndOpenAITranslationUseCPA(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/messages" || (r.Header.Get("X-Api-Key") != "upstream-key" && r.Header.Get("Authorization") != "Bearer upstream-key") || r.Header.Get("Anthropic-Version") == "" {
					t.Errorf("Claude upstream request = %s %v", r.URL, r.Header)
				}
				body, _ := io.ReadAll(r.Body)
				if !bytes.Contains(body, []byte(`"messages"`)) || bytes.Contains(body, []byte("internal-test-key")) {
					t.Errorf("invalid translated Claude request: %s", body)
				}
				var payload struct {
					Stream bool `json:"stream"`
				}
				_ = json.Unmarshal(body, &payload)
				if payload.Stream {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"pong\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}`)
			}))
			defer upstream.Close()
			document, _ := json.Marshal(map[string]any{"type": "claude", "api_key": "upstream-key", "base_url": upstream.URL, "auth_kind": "api_key"})
			runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{ID: "claude-test", Provider: "anthropic", Enabled: true, Models: []string{"claude-test"}, Document: document}})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close(context.Background())
			body := `{"model":"claude-test","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
			if path == "/v1/responses" {
				body = `{"model":"claude-test","input":"hi","max_output_tokens":16}`
			}
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer internal-test-key")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Relay-CPA-Auth-ID", "claude-test")
			request.Header.Set("X-Relay-Request-ID", "claude-parity")
			response := httptest.NewRecorder()
			runtime.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "pong") {
				t.Fatalf("CPA %s translation = %d %s", path, response.Code, response.Body.String())
			}
			usage, complete := runtime.RequestUsage(t.Context(), "claude-parity", "")
			if !complete || !usage.Found || usage.InputTokens <= 0 || usage.OutputTokens != 2 {
				t.Fatalf("Claude translation lost canonical CPA usage: %+v, complete=%v", usage, complete)
			}
		})
	}
}
