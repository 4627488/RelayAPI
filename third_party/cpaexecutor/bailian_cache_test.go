package relaybridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

func TestResolveBailianCacheAuth(t *testing.T) {
	t.Parallel()
	base := &cliproxyauth.Auth{ID: "bailian", Attributes: map[string]string{
		"vendor": "aliyun-bailian", "cache_mode": "auto",
	}}
	fullReplay := cliproxyexecutor.Request{Payload: []byte(`{"model":"qwen3.8-max","input":"hi"}`)}
	got := resolveBailianCacheAuth(base, fullReplay, cliproxyexecutor.Options{})
	if got == base {
		t.Fatal("auto full-replay should return a copied auth")
	}
	if got.Attributes["cache_mode"] != "off" {
		t.Fatalf("auto full-replay cache_mode = %q, want off", got.Attributes["cache_mode"])
	}
	if base.Attributes["cache_mode"] != "auto" {
		t.Fatalf("original cache_mode mutated to %q", base.Attributes["cache_mode"])
	}

	incremental := cliproxyexecutor.Request{Payload: []byte(`{"model":"qwen3.8-max","previous_response_id":"resp_1","input":"next"}`)}
	got = resolveBailianCacheAuth(base, incremental, cliproxyexecutor.Options{})
	if got.Attributes["cache_mode"] != "session" {
		t.Fatalf("auto incremental cache_mode = %q, want session", got.Attributes["cache_mode"])
	}

	got = resolveBailianCacheAuth(base, fullReplay, cliproxyexecutor.Options{
		OriginalRequest: []byte(`{"previous_response_id":"resp_orig"}`),
	})
	if got.Attributes["cache_mode"] != "session" {
		t.Fatalf("original-request previous id cache_mode = %q, want session", got.Attributes["cache_mode"])
	}

	forced := &cliproxyauth.Auth{Attributes: map[string]string{"vendor": "aliyun-bailian", "cache_mode": "session"}}
	if resolveBailianCacheAuth(forced, fullReplay, cliproxyexecutor.Options{}) != forced {
		t.Fatal("explicit session mode should be left alone")
	}
	off := &cliproxyauth.Auth{Attributes: map[string]string{"vendor": "aliyun-bailian", "cache_mode": "off"}}
	if resolveBailianCacheAuth(off, incremental, cliproxyexecutor.Options{}) != off {
		t.Fatal("explicit off mode should be left alone")
	}
	other := &cliproxyauth.Auth{Attributes: map[string]string{"vendor": "openai", "cache_mode": "auto"}}
	if resolveBailianCacheAuth(other, incremental, cliproxyexecutor.Options{}) != other {
		t.Fatal("non-Bailian auth should be left alone")
	}
}

func TestBailianAutoSessionCacheHeader(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{name: "full replay uses implicit cache", payload: `{"model":"qwen3.8-max","input":"hi"}`},
		{name: "previous response id uses session cache", payload: `{"model":"qwen3.8-max","previous_response_id":"resp_1","input":"hi"}`, want: "enable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var gotHeader string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotHeader = r.Header.Get("x-dashscope-session-cache")
				_, _ = io.ReadAll(r.Body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"resp_auto","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}`))
			}))
			t.Cleanup(server.Close)

			exec := executor.NewOpenAICompatExecutor("openai-compatibility", &config.Config{})
			auth := resolveBailianCacheAuth(&cliproxyauth.Auth{Attributes: map[string]string{
				"base_url": server.URL + "/v1", "api_key": "test", "upstream_api": "auto",
				"vendor": "aliyun-bailian", "cache_mode": "auto",
			}}, cliproxyexecutor.Request{Model: "qwen3.8-max", Payload: []byte(test.payload)}, cliproxyexecutor.Options{})
			_, err := exec.Execute(context.Background(), auth, cliproxyexecutor.Request{
				Model: "qwen3.8-max", Payload: []byte(test.payload),
			}, cliproxyexecutor.Options{
				SourceFormat: sdktranslator.FormatOpenAIResponse, ResponseFormat: sdktranslator.FormatOpenAIResponse,
			})
			if err != nil {
				t.Fatal(err)
			}
			if gotHeader != test.want {
				t.Fatalf("x-dashscope-session-cache = %q, want %q", gotHeader, test.want)
			}
		})
	}
}

func TestHasPreviousResponseID(t *testing.T) {
	t.Parallel()
	if hasPreviousResponseID([]byte(`{"previous_response_id":"resp_1"}`)) != true {
		t.Fatal("expected previous_response_id to be detected")
	}
	if hasPreviousResponseID([]byte(`{"previous_response_id":"  "}`)) {
		t.Fatal("blank previous_response_id should be ignored")
	}
	if hasPreviousResponseID([]byte(`{"input":"hi"}`)) {
		t.Fatal("missing previous_response_id should be false")
	}
}
