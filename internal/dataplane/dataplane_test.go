package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestDetectProtocol(t *testing.T) {
	t.Parallel()
	tests := map[string]Protocol{
		"/v1/chat/completions":                        ProtocolOpenAI,
		"/v1/responses":                               ProtocolResponses,
		"/openai/v1/responses":                        ProtocolResponses,
		"/backend-api/codex/responses":                ProtocolCodex,
		"/v1/messages":                                ProtocolClaude,
		"/v1beta/models/gemini:streamGenerateContent": ProtocolGemini,
	}
	for path, want := range tests {
		got, err := DetectProtocol(path)
		if err != nil || got != want {
			t.Errorf("DetectProtocol(%q) = %q, %v; want %q", path, got, err, want)
		}
	}
}

func TestEngineReusesNativeHTTPPath(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer upstream-key" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte(`"model":"native-model"`)) {
			t.Errorf("body = %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	plan := RoutePlan{Provider: "openai", CredentialID: "key", Model: "native-model", Endpoint: endpoint, Inbound: ProtocolOpenAI, Upstream: ProtocolOpenAI}
	credential := Credential{ID: "key", Provider: "openai", Endpoint: endpoint, APIKey: "upstream-key"}
	engine := NewEngine(NewTranslator(), NewTransportPool(4, time.Second))
	exchange, err := engine.Do(context.Background(), plan, credential, nil, []byte(`{"model":"native-model","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer exchange.Response.Body.Close()
	var output bytes.Buffer
	if err := engine.CopyResponse(context.Background(), &output, exchange, nil); err != nil {
		t.Fatal(err)
	}
	if output.String() != `{"ok":true}` {
		t.Fatalf("output = %s", output.String())
	}
}

func TestCompletedSSEPayload(t *testing.T) {
	t.Parallel()
	payload, err := completedSSEPayload([]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n"))
	if err != nil || !bytes.Contains(payload, []byte(`"id":"r"`)) {
		t.Fatalf("payload = %s, %v", payload, err)
	}
}

func TestOpenAIStreamFraming(t *testing.T) {
	t.Parallel()
	raw := []byte(`{"object":"chat.completion.chunk","choices":[]}`)
	if got := string(frameStreamChunk(ProtocolOpenAI, raw)); got != "data: "+string(raw)+"\n\n" {
		t.Fatalf("framed chunk = %q", got)
	}
	if got := string(terminalStreamChunk(ProtocolOpenAI)); got != "data: [DONE]\n\n" {
		t.Fatalf("terminal chunk = %q", got)
	}
	if got := frameStreamChunk(ProtocolClaude, raw); !bytes.Equal(got, raw) {
		t.Fatalf("Claude chunk changed: %q", got)
	}
}

func TestCodexResponsesLiteDisablesParallelToolCalls(t *testing.T) {
	t.Parallel()
	plan := RoutePlan{Upstream: ProtocolCodex, Model: "gpt-5.6-sol"}
	headers := make(http.Header)
	headers.Set("X-OpenAI-Internal-Codex-Responses-Lite", "true")
	body := normalizeProviderRequest(plan, []byte(`{"model":"gpt-5.6-sol","parallel_tool_calls":true}`), headers)
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	if value, ok := request["parallel_tool_calls"].(bool); !ok || value {
		t.Fatalf("parallel_tool_calls = %#v, want false; body=%s", request["parallel_tool_calls"], body)
	}
}

func TestTranslateWebSocketRequestPreservesContinuationAndNormalizesLite(t *testing.T) {
	t.Parallel()
	engine := &Engine{Translator: NewTranslator()}
	plan := RoutePlan{Inbound: ProtocolResponses, Upstream: ProtocolCodex, Model: "gpt-5.6-sol"}
	headers := make(http.Header)
	headers.Set("X-OpenAI-Internal-Codex-Responses-Lite", "true")
	body, err := engine.TranslateWebSocketRequest(plan, []byte(`{"type":"response.append","previous_response_id":"resp_1","parallel_tool_calls":true,"input":[]}`), headers)
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	if request["type"] != "response.create" || request["model"] != "gpt-5.6-sol" || request["previous_response_id"] != "resp_1" || request["parallel_tool_calls"] != false {
		t.Fatalf("normalized websocket request = %s", body)
	}
}

func TestTranslatorRequiredClientMatrix(t *testing.T) {
	t.Parallel()
	translator := NewTranslator()
	clients := []Protocol{ProtocolOpenAI, ProtocolResponses, ProtocolClaude}
	providers := []Protocol{ProtocolOpenAI, ProtocolCodex, ProtocolClaude}
	for _, client := range clients {
		for _, provider := range providers {
			if !translator.Supports(client, provider, true) {
				t.Errorf("missing streaming translation %s -> %s -> %s", client, provider, client)
			}
			if !translator.Supports(client, provider, false) {
				t.Errorf("missing non-stream translation %s -> %s -> %s", client, provider, client)
			}
		}
	}
}

func TestTranslatorUsesProviderToClientResponseDirection(t *testing.T) {
	t.Parallel()
	translator := NewTranslator()
	original := []byte(`{"model":"gpt-test","max_tokens":16,"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	translated, err := translator.TranslateRequest(ProtocolClaude, ProtocolCodex, "gpt-test", original, true)
	if err != nil {
		t.Fatal(err)
	}
	line := []byte(`data: {"type":"response.created","response":{"id":"resp_test","model":"gpt-test","created_at":1,"output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}`)
	chunks, err := translator.TranslateStreamLine(context.Background(), ProtocolClaude, ProtocolCodex, "gpt-test", original, translated, line, &StreamState{})
	if err != nil {
		t.Fatal(err)
	}
	joined := bytes.Join(chunks, nil)
	if bytes.Contains(joined, []byte(`"response.created"`)) || !bytes.Contains(joined, []byte(`message_start`)) {
		t.Fatalf("Codex response was not translated to Claude SSE: %s", joined)
	}
}

func TestTransportPoolReusesClientsByProxyRoute(t *testing.T) {
	t.Parallel()
	pool := NewTransportPool(12, 3*time.Second)
	first, err := pool.Client("http://proxy.example:8080")
	if err != nil {
		t.Fatal(err)
	}
	second, err := pool.Client("http://proxy.example:8080")
	if err != nil {
		t.Fatal(err)
	}
	direct, err := pool.Client("direct")
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first == direct {
		t.Fatal("clients were not pooled by proxy route")
	}
	transport, ok := first.Transport.(*http.Transport)
	if !ok || transport.MaxIdleConnsPerHost != 12 || transport.ResponseHeaderTimeout != 3*time.Second {
		t.Fatalf("unexpected transport: %#v", first.Transport)
	}
}

func TestRoutePlanValidation(t *testing.T) {
	t.Parallel()
	endpoint, _ := url.Parse("https://api.example.test/v1/responses")
	plan := RoutePlan{Provider: "codex", CredentialID: "auth-1", Model: "gpt-5", Endpoint: endpoint, Inbound: ProtocolResponses, Upstream: ProtocolCodex, Stream: true}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialCatalogPlansAndRoundRobins(t *testing.T) {
	t.Parallel()
	endpoint, _ := url.Parse("https://upstream.example/v1/responses")
	catalog := NewCredentialCatalog()
	credentials := []Credential{
		{ID: "a", Provider: "xai", Endpoint: endpoint, AccessToken: "secret-a", Models: []ModelRoute{{Public: "grok", Upstream: "grok-4"}}},
		{ID: "b", Provider: "xai", Endpoint: endpoint, AccessToken: "secret-b", Models: []ModelRoute{{Public: "grok", Upstream: "grok-4"}}},
	}
	if err := catalog.Replace(credentials); err != nil {
		t.Fatal(err)
	}
	if catalog.Len() != 2 || len(catalog.Models()) != 1 || catalog.Models()[0] != "grok" {
		t.Fatalf("catalog metadata = %d, %#v", catalog.Len(), catalog.Models())
	}
	first, _, err := catalog.Plan("/v1/responses", "", "grok", true)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := catalog.Plan("/v1/responses", "", "grok", true)
	if err != nil {
		t.Fatal(err)
	}
	if first.CredentialID == second.CredentialID || first.Model != "grok-4" || first.Upstream != ProtocolCodex {
		t.Fatalf("unexpected plans: %#v %#v", first, second)
	}
	explicit, _, err := catalog.Plan("/v1/messages", "a", "claude-alias", false)
	if err != nil || explicit.CredentialID != "a" || explicit.Inbound != ProtocolClaude {
		t.Fatalf("explicit plan = %#v, %v", explicit, err)
	}
}

func TestCredentialApplyDoesNotPutSecretsInPoolIdentity(t *testing.T) {
	t.Parallel()
	request, _ := http.NewRequest(http.MethodPost, "https://example.test", nil)
	credential := Credential{ID: "codex", Provider: "codex", AccessToken: "secret", AccountID: "account"}
	if err := credential.Apply(request); err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("Authorization") != "Bearer secret" || request.Header.Get("ChatGPT-Account-ID") != "account" {
		t.Fatalf("unexpected auth headers: %#v", request.Header)
	}
}

func TestCompileCredentialDefaultsAndModelRoutes(t *testing.T) {
	t.Parallel()
	credential, err := CompileCredential("xai.json", "xai", "xai", []string{"grok-public"}, []byte(`{
		"access_token":"secret","base_url":"https://cli-chat-proxy.grok.com/v1","_relay_proxy_url":"socks5://proxy:1080"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if credential.Endpoint.String() != "https://cli-chat-proxy.grok.com/v1/responses" || credential.ProxyURL != "socks5://proxy:1080" {
		t.Fatalf("unexpected credential: %#v", credential)
	}
	if len(credential.Models) != 1 || credential.Models[0].Public != "grok-public" {
		t.Fatalf("unexpected models: %#v", credential.Models)
	}
}
