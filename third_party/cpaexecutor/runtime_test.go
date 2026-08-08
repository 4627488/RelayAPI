package relaybridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

func TestRuntimeRegistersCompletePublicInferenceSurface(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex.json", Label: "Codex", Provider: "codex", Enabled: true,
		Models:   []string{"gpt-image-1", "gpt-5.4"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	engine, ok := runtime.Handler().(*gin.Engine)
	if !ok {
		t.Fatalf("handler type = %T, want *gin.Engine", runtime.Handler())
	}
	routes := make(map[string]struct{})
	for _, route := range engine.Routes() {
		routes[route.Method+" "+route.Path] = struct{}{}
	}
	for _, expected := range []string{
		"GET /v1/models",
		"POST /v1/chat/completions", "POST /v1/completions",
		"POST /v1/images/generations", "POST /v1/images/edits",
		"POST /v1/videos", "POST /v1/videos/generations", "POST /v1/videos/edits", "POST /v1/videos/extensions",
		"GET /v1/videos/:request_id",
		"POST /v1/messages", "POST /v1/messages/count_tokens",
		"GET /v1/responses", "POST /v1/responses", "POST /v1/responses/compact",
		"POST /v1/alpha/search", "POST /v1/live", "GET /v1/live/:call_id",
		"POST /v1/realtime/calls", "GET /v1/realtime/calls/:call_id", "GET /v1/realtime",
		"POST /openai/v1/videos", "GET /openai/v1/videos/:video_id", "GET /openai/v1/videos/:video_id/content",
		"GET /backend-api/codex/responses", "POST /backend-api/codex/responses", "POST /backend-api/codex/responses/compact", "POST /backend-api/codex/alpha/search",
		"GET /v1beta/models", "POST /v1beta/models/*action", "GET /v1beta/models/*action",
		"POST /v1beta/interactions",
	} {
		if _, exists := routes[expected]; !exists {
			t.Errorf("missing CPA route %s", expected)
		}
	}
}

func TestRuntimeApplySettingsRebuildsCredentialsWithGlobalProxy(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "openai-main", Provider: "openai", Enabled: true, Models: []string{"gpt-test"},
		Document: []byte(`{"type":"openai","api_key":"secret","base_url":"https://example.test/v1"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	err = runtime.ApplySettings(context.Background(), Settings{
		RequestRetry: 4, MaxRetryCredentials: 2, MaxRetryInterval: 12 * time.Second,
		RoutingStrategy: "fill-first", ProxyURL: "socks5h://127.0.0.1:1080",
		PassthroughHeaders: true, DisableImageGeneration: "chat", GPTImage2BaseModel: "gpt-5.4-mini",
		VideoResultAuthCacheTTL: "2h", StreamKeepAliveSeconds: 10, StreamBootstrapRetries: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	auth, ok := runtime.manager.GetByID("openai-main")
	if !ok {
		t.Fatal("credential was not re-registered")
	}
	if auth.ProxyURL != "socks5h://127.0.0.1:1080" {
		t.Fatalf("proxy = %q", auth.ProxyURL)
	}
	if runtime.cfg.RequestRetry != 4 || runtime.cfg.MaxRetryCredentials != 2 || runtime.cfg.MaxRetryInterval != 12 {
		t.Fatalf("retry configuration was not updated: %#v", runtime.cfg)
	}
	if runtime.cfg.DisableImageGeneration.String() != "chat" {
		t.Fatalf("image mode = %s", runtime.cfg.DisableImageGeneration.String())
	}
}

func TestCredentialProxyOverridesGlobalProxy(t *testing.T) {
	auth, _, _, err := compileCredential(Credential{ID: "custom-proxy", Provider: "openai", Enabled: true, Models: []string{"gpt-test"}, Document: []byte(`{"type":"openai","api_key":"secret","proxy_url":"http://account.proxy:8080"}`)}, "http://global.proxy:8080")
	if err != nil {
		t.Fatal(err)
	}
	if auth.ProxyURL != "http://account.proxy:8080" {
		t.Fatalf("proxy = %q", auth.ProxyURL)
	}
}

func TestImagesEndpointNoLongerReturnsUnsupportedAPIPath(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	request := httptest.NewRequest(http.MethodPost, "/v1/images/generations", bytes.NewBufferString("["))
	request.Header.Set("Authorization", "Bearer internal-test-key")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(response, request)
	if response.Code == http.StatusNotFound || strings.Contains(strings.ToLower(response.Body.String()), "unsupported api path") {
		t.Fatalf("image endpoint was not dispatched: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRuntimeRoutesPinnedCredentialAndModelAlias(t *testing.T) {
	document, _ := json.Marshal(map[string]any{
		"api_key": "secret", "base_url": "https://example.test/v1",
		"model_routes": []map[string]string{{"public": "public-image", "upstream": "gpt-image-1"}},
	})
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "image-provider", Provider: "openai", Enabled: true,
		Models: []string{"public-image"}, Document: document,
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	request := pluginapi.ModelRouteRequest{
		RequestedModel: "public-image",
		Headers:        http.Header{"X-Relay-Cpa-Auth-Id": []string{"image-provider"}},
	}
	response, ok := runtime.RouteModel(context.Background(), request)
	if !ok || !response.Handled {
		t.Fatal("pinned credential route was not handled")
	}
	if response.Target != "openai" || response.TargetModel != "gpt-image-1" {
		t.Fatalf("route = %#v", response)
	}
}
