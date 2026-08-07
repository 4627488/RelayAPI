package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCompatibilityExecutorCodexRequestAndStream(t *testing.T) {
	requestBody := make(chan []byte, 1)
	requestHeaders := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestBody <- body
		requestHeaders <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\",\"output\":[]}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n")
	}))
	defer server.Close()

	endpoint, err := url.Parse(server.URL + "/responses")
	if err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(NewTranslator(), NewTransportPool(4, 5*time.Second))
	plan := RoutePlan{
		Provider: "codex", CredentialID: "codex-1", Model: "gpt-test", Endpoint: endpoint,
		Inbound: ProtocolResponses, Upstream: ProtocolCodex, Stream: true,
	}
	credential := Credential{ID: "codex-1", Name: "test", Provider: "codex", Endpoint: endpoint, AccessToken: "secret"}
	headers := http.Header{"X-Openai-Internal-Codex-Responses-Lite": {"true"}}
	original := []byte(`{"model":"gpt-test","parallel_tool_calls":true,"input":[{"type":"message","id":"msg_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_123456789","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`)

	exchange, err := engine.Do(context.Background(), plan, credential, headers, original)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer exchange.Response.Body.Close()
	gotStream, err := io.ReadAll(exchange.Response.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if !strings.Contains(string(gotStream), `"type":"response.completed"`) {
		t.Fatalf("stream did not preserve completion event: %s", gotStream)
	}

	var upstream map[string]any
	if err := json.Unmarshal(<-requestBody, &upstream); err != nil {
		t.Fatalf("decode upstream request: %v", err)
	}
	if upstream["parallel_tool_calls"] != false {
		t.Fatalf("parallel_tool_calls = %#v, want false for Responses Lite", upstream["parallel_tool_calls"])
	}
	if _, ok := upstream["instructions"]; !ok {
		t.Fatal("CPA executor did not normalize missing instructions")
	}
	if got := upstream["model"]; got != "gpt-test" {
		t.Fatalf("model = %#v, want gpt-test", got)
	}
	upstreamHeaders := <-requestHeaders
	if got := upstreamHeaders.Get("Authorization"); got != "Bearer secret" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := upstreamHeaders.Get("Originator"); got != "codex-tui" {
		t.Fatalf("Originator = %q", got)
	}
}

func TestExecutorBaseURL(t *testing.T) {
	endpoint, _ := url.Parse("https://example.test/custom/v1/responses?ignored=yes")
	if got := executorBaseURL(endpoint); got != "https://example.test/custom/v1" {
		t.Fatalf("executorBaseURL() = %q", got)
	}
}

func TestCompatibilityExecutorXAIRequestAndStream(t *testing.T) {
	requestBody := make(chan []byte, 1)
	requestHeaders := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestBody <- body
		requestHeaders <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_xai\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n")
	}))
	defer server.Close()

	endpoint, _ := url.Parse(server.URL + "/responses")
	engine := NewEngine(NewTranslator(), NewTransportPool(4, 5*time.Second))
	plan := RoutePlan{Provider: "grok", CredentialID: "xai-1", Model: "grok-code-fast-1", Endpoint: endpoint,
		Inbound: ProtocolResponses, Upstream: ProtocolCodex, Stream: true}
	credential := Credential{ID: "xai-1", Provider: "grok", Endpoint: endpoint, AccessToken: "xai-secret"}
	exchange, err := engine.Do(context.Background(), plan, credential, nil,
		[]byte(`{"model":"grok-code-fast-1","input":"hello","tools":[{"type":"custom","name":"shell","description":"run","format":{}}]}`))
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer exchange.Response.Body.Close()
	if _, err := io.ReadAll(exchange.Response.Body); err != nil {
		t.Fatalf("read stream: %v", err)
	}
	var upstream map[string]any
	if err := json.Unmarshal(<-requestBody, &upstream); err != nil {
		t.Fatal(err)
	}
	if upstream["model"] != "grok-code-fast-1" {
		t.Fatalf("model = %#v", upstream["model"])
	}
	gotHeaders := <-requestHeaders
	if got := gotHeaders.Get("Authorization"); got != "Bearer xai-secret" {
		t.Fatalf("Authorization = %q", got)
	}
	// CPA only emits Grok CLI identity headers for its official CLI endpoint;
	// custom base URLs deliberately receive the standard bearer header set.
	if got := gotHeaders.Get("X-XAI-Token-Auth"); got != "" {
		t.Fatalf("unexpected X-XAI-Token-Auth on custom endpoint: %q", got)
	}
}

func TestCompatibilityExecutorClientProtocolMatrix(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		inbound  Protocol
		body     string
		want     string
	}{
		{name: "codex-responses", provider: "codex", inbound: ProtocolResponses,
			body: `{"model":"model-test","input":"hello"}`, want: `"output"`},
		{name: "codex-opencode-chat", provider: "codex", inbound: ProtocolOpenAI,
			body: `{"model":"model-test","messages":[{"role":"user","content":"hello"}]}`, want: `"choices"`},
		{name: "codex-claude-code", provider: "codex", inbound: ProtocolClaude,
			body: `{"model":"model-test","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`, want: `"type":"message"`},
		{name: "grok-responses", provider: "grok", inbound: ProtocolResponses,
			body: `{"model":"model-test","input":"hello"}`, want: `"output"`},
		{name: "grok-opencode-chat", provider: "grok", inbound: ProtocolOpenAI,
			body: `{"model":"model-test","messages":[{"role":"user","content":"hello"}]}`, want: `"choices"`},
		{name: "grok-claude-code", provider: "grok", inbound: ProtocolClaude,
			body: `{"model":"model-test","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`, want: `"type":"message"`},
	}
	completed := `data: {"type":"response.completed","response":{"id":"resp_matrix","object":"response","created_at":1,"status":"completed","model":"model-test","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}` + "\n\n"
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, completed)
			}))
			defer server.Close()
			endpoint, _ := url.Parse(server.URL + "/responses")
			engine := NewEngine(NewTranslator(), NewTransportPool(2, 5*time.Second))
			plan := RoutePlan{Provider: test.provider, CredentialID: "credential", Model: "model-test", Endpoint: endpoint,
				Inbound: test.inbound, Upstream: ProtocolCodex, Stream: false}
			credential := Credential{ID: "credential", Provider: test.provider, Endpoint: endpoint, AccessToken: "token"}
			exchange, err := engine.Do(context.Background(), plan, credential, nil, []byte(test.body))
			if err != nil {
				t.Fatalf("Do() error = %v", err)
			}
			defer exchange.Response.Body.Close()
			payload, err := io.ReadAll(exchange.Response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if !json.Valid(payload) || !strings.Contains(string(payload), test.want) {
				t.Fatalf("response = %s, want marker %s", payload, test.want)
			}
		})
	}
}
