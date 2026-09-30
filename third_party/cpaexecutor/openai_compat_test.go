package relaybridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// A plugin may delete a configuration update before execution. The original
// request must not restore that update during CPA's thinking normalization.
type removeConfigurationUpdateHooks struct{}

func (removeConfigurationUpdateHooks) NormalizeRequest(_ context.Context, _, _ sdktranslator.Format, _ string, body []byte, _ bool) []byte {
	out, _ := sjson.DeleteBytes(body, "input.0")
	return out
}

func (removeConfigurationUpdateHooks) TranslateRequest(context.Context, sdktranslator.Format, sdktranslator.Format, string, []byte, bool) ([]byte, bool) {
	return nil, false
}

func (removeConfigurationUpdateHooks) NormalizeResponseBefore(_ context.Context, _, _ sdktranslator.Format, _ string, _, _, body []byte, _ bool) []byte {
	return body
}

func (removeConfigurationUpdateHooks) TranslateResponse(context.Context, sdktranslator.Format, sdktranslator.Format, string, []byte, []byte, []byte, bool) ([]byte, bool) {
	return nil, false
}

func (removeConfigurationUpdateHooks) NormalizeResponseAfter(_ context.Context, _, _ sdktranslator.Format, _ string, _, _, body []byte, _ bool) []byte {
	return body
}

func TestOpenAICompatResponsesHonorsPluginConfigurationUpdateRemoval(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "nonstream"
		if stream {
			name = "stream"
		}
		t.Run(name, func(t *testing.T) {
			sdktranslator.SetPluginHooks(removeConfigurationUpdateHooks{})
			t.Cleanup(func() { sdktranslator.SetPluginHooks(nil) })
			var gotBody []byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotBody, _ = io.ReadAll(r.Body)
				response := `{"id":"resp_update","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}`
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":"+response+"}\n\n")
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, response)
			}))
			defer server.Close()
			exec := newOpenAICompatExecutor("openai-compatibility", &sdkconfig.Config{})
			auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{
				"base_url": server.URL + "/v1", "api_key": "test", "upstream_api": "responses",
			}}
			req := cliproxyexecutor.Request{Model: "private-responses", Payload: []byte(`{"model":"private-responses","reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"hi"}]}`), Metadata: map[string]any{
				"cliproxy.resolved_api_key_model_info": &cliproxy.ModelInfo{ID: "private-responses", UserDefined: true},
			}}
			opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, Stream: stream}
			if stream {
				result, err := exec.ExecuteStream(t.Context(), auth, req, opts)
				if err != nil {
					t.Fatal(err)
				}
				for chunk := range result.Chunks {
					if chunk.Err != nil {
						t.Fatal(chunk.Err)
					}
				}
			} else if _, err := exec.Execute(t.Context(), auth, req, opts); err != nil {
				t.Fatal(err)
			}
			if got := gjson.GetBytes(gotBody, "reasoning.effort").String(); got != "medium" {
				t.Fatalf("plugin removal was overwritten: reasoning.effort = %q; body=%s", got, gotBody)
			}
			if len(gjson.GetBytes(gotBody, "input").Array()) != 1 {
				t.Fatalf("configuration update retained: %s", gotBody)
			}
		})
	}
}

func TestOpenAICompatExecutorUsesConfiguredResponsesUpstream(t *testing.T) {
	var gotPath string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","object":"response","status":"completed","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	exec := newOpenAICompatExecutor("openai-compatibility", &sdkconfig.Config{})
	auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{
		"base_url": server.URL + "/v1", "api_key": "test", "upstream_api": "responses",
	}}
	req := cliproxyexecutor.Request{Model: "qwen3.8-max", Payload: []byte(`{"model":"qwen3.8-max","messages":[{"role":"user","content":"hi"}]}`)}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI, ResponseFormat: sdktranslator.FormatOpenAI}

	resp, err := exec.Execute(context.Background(), auth, req, opts)
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}
	if gotPath != "/v1/responses" {
		t.Fatalf("path = %q, want /v1/responses", gotPath)
	}
	if !gjson.GetBytes(gotBody, "input").Exists() || gjson.GetBytes(gotBody, "messages").Exists() {
		t.Fatalf("request was not translated to Responses: %s", gotBody)
	}
	if got := gjson.GetBytes(resp.Payload, "choices.0.message.content").String(); got != "ok" {
		t.Fatalf("translated response content = %q, want ok; payload=%s", got, resp.Payload)
	}
}

func TestOpenAICompatExecutorAutoSelectsProtocolAndBailianCache(t *testing.T) {
	tests := []struct {
		name        string
		source      sdktranslator.Format
		cacheMode   string
		wantPath    string
		wantSession bool
	}{
		{name: "responses uses session cache", source: sdktranslator.FormatOpenAIResponse, cacheMode: "auto", wantPath: "/v1/responses", wantSession: true},
		{name: "chat keeps chat protocol", source: sdktranslator.FormatOpenAI, cacheMode: "auto", wantPath: "/v1/chat/completions"},
		{name: "cache can be disabled", source: sdktranslator.FormatOpenAIResponse, cacheMode: "off", wantPath: "/v1/responses"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var gotPath, gotSessionCache string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				gotSessionCache = r.Header.Get("x-dashscope-session-cache")
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "/responses") {
					_, _ = w.Write([]byte(`{"id":"resp_auto","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}`))
					return
				}
				_, _ = w.Write([]byte(`{"id":"chat_auto","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
			}))
			defer server.Close()

			exec := newOpenAICompatExecutor("openai-compatibility", &sdkconfig.Config{})
			auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{
				"base_url": server.URL + "/v1", "api_key": "test", "upstream_api": "auto",
				"vendor": "aliyun-bailian", "cache_mode": test.cacheMode,
			}}
			payload := []byte(`{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}]}`)
			if test.source == sdktranslator.FormatOpenAIResponse {
				payload = []byte(`{"model":"qwen-plus","input":"hi"}`)
			}
			metadata := make(map[string]any)
			_, err := exec.Execute(context.Background(), auth, cliproxyexecutor.Request{Model: "qwen-plus", Payload: payload}, cliproxyexecutor.Options{
				SourceFormat: test.source, ResponseFormat: test.source, Metadata: metadata,
			})
			if err != nil {
				t.Fatalf("Execute error: %v", err)
			}
			if gotPath != test.wantPath {
				t.Fatalf("path = %q, want %q", gotPath, test.wantPath)
			}
			if got := gotSessionCache == "enable"; got != test.wantSession {
				t.Fatalf("session cache enabled = %v, want %v", got, test.wantSession)
			}
			if test.wantPath == "/v1/responses" {
				if got := metadata[responseAffinityIDMetadataKey]; got != "resp_auto" {
					t.Fatalf("response affinity ID = %#v, want resp_auto", got)
				}
			}
		})
	}
}

func TestOpenAICompatExecutorStreamsConfiguredResponsesUpstream(t *testing.T) {
	var gotPath string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	exec := newOpenAICompatExecutor("openai-compatibility", &sdkconfig.Config{})
	auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{
		"base_url": server.URL + "/v1", "api_key": "test", "upstream_api": "responses",
	}}
	req := cliproxyexecutor.Request{Model: "qwen3.8-max", Payload: []byte(`{"model":"qwen3.8-max","messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true}}`)}
	metadata := make(map[string]any)
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI, ResponseFormat: sdktranslator.FormatOpenAI, Stream: true, Metadata: metadata}

	result, err := exec.ExecuteStream(context.Background(), auth, req, opts)
	if err != nil {
		t.Fatalf("ExecuteStream error: %v", err)
	}
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatalf("stream chunk error: %v", chunk.Err)
		}
	}
	if gotPath != "/v1/responses" {
		t.Fatalf("path = %q, want /v1/responses", gotPath)
	}
	if gjson.GetBytes(gotBody, "stream_options").Exists() {
		t.Fatalf("Responses request retained chat-only stream_options: %s", gotBody)
	}
	if !gjson.GetBytes(gotBody, "input").Exists() || gjson.GetBytes(gotBody, "messages").Exists() {
		t.Fatalf("stream request was not translated to Responses: %s", gotBody)
	}
	if got := metadata[responseAffinityIDMetadataKey]; got != "resp_1" {
		t.Fatalf("stream response affinity ID = %#v, want resp_1", got)
	}
}
