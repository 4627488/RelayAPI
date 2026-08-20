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
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

func TestRuntimeUsesCPAStaticModelsWhenCredentialModelsAreEmpty(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex-static", Provider: "codex", Enabled: true,
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	models, source, err := runtime.DiscoverCredentialModels(context.Background(), "codex-static")
	if err != nil {
		t.Fatal(err)
	}
	if source != "cpa_static" || len(models) == 0 {
		t.Fatalf("models = %v, source = %q; want CPA static registry", models, source)
	}
	if got := runtime.CredentialModels("codex-static"); len(got) != len(models) {
		t.Fatalf("credential models = %d, discovered = %d", len(got), len(models))
	}
}

func TestRuntimeUsesCPACodexPlanAndModelMetadata(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex-free", Provider: "codex", Enabled: true,
		Document: []byte(`{"type":"codex","access_token":"test-token","plan_type":"free"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	got := runtime.CredentialModels("codex-free")
	want := modelIDs(registry.GetCodexFreeModels())
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("free plan models differ from CPA registry\ngot: %v\nwant: %v", got, want)
	}
	registered := registry.GetGlobalRegistry().GetModelsForClient("codex-free")
	hasCapabilityMetadata := false
	for _, model := range registered {
		if model != nil && (model.ContextLength > 0 || model.MaxContextLength > 0 || model.Thinking != nil || len(model.SupportedInputModalities) > 0) {
			hasCapabilityMetadata = true
			break
		}
	}
	if !hasCapabilityMetadata {
		t.Fatal("CPA model capability metadata was discarded")
	}
	status, ok := runtime.CredentialStatus("codex-free")
	if !ok || status.Status != string(coreauth.StatusActive) || status.PlanType != "free" {
		t.Fatalf("credential status = %+v, ok=%v", status, ok)
	}
}

func TestRuntimeHonorsCPAOAuthModelExclusionsAndAliases(t *testing.T) {
	baseModels := registry.GetCodexFreeModels()
	if len(baseModels) < 2 {
		t.Fatal("CPA free model catalog is unexpectedly small")
	}
	excluded := baseModels[0].ID
	aliased := baseModels[1].ID
	document, _ := json.Marshal(map[string]any{
		"type": "codex", "access_token": "test-token", "plan_type": "free",
		"excluded_models": []string{excluded},
		"model_aliases":   []map[string]any{{"name": aliased, "alias": "oauth-visible-alias"}},
	})
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex-oauth-policy", Provider: "codex", Enabled: true, Document: document,
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	models, source, err := runtime.DiscoverCredentialModels(context.Background(), "codex-oauth-policy")
	if err != nil {
		t.Fatal(err)
	}
	joined := "\n" + strings.Join(models, "\n") + "\n"
	if source != "cpa_static" || strings.Contains(joined, "\n"+excluded+"\n") {
		t.Fatalf("excluded model remained in CPA catalog: %v", models)
	}
	if strings.Contains(joined, "\n"+aliased+"\n") || !strings.Contains(joined, "\noauth-visible-alias\n") {
		t.Fatalf("CPA OAuth alias policy was not applied: %v", models)
	}
}

func TestRuntimeDiscoversOpenAICompatibleModelsThroughCPAExecutor(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer dashscope-test-key" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen-plus"},{"id":"qwen-max"},{"id":"qwen-plus"}]}`))
	}))
	defer upstream.Close()

	document, _ := json.Marshal(map[string]any{
		"type": "openai-compatibility", "api_key": "dashscope-test-key", "base_url": upstream.URL + "/v1",
	})
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "bailian", Provider: "aliyun-bailian", Enabled: true, Document: document,
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	auth, ok := runtime.manager.GetByID("bailian")
	if !ok {
		t.Fatal("Bailian credential was not installed")
	}
	if auth.Attributes["upstream_api"] != "auto" {
		t.Fatalf("Bailian upstream API = %q, want auto", auth.Attributes["upstream_api"])
	}
	if auth.Attributes["vendor"] != "aliyun-bailian" || auth.Attributes["cache_mode"] != "auto" || auth.Attributes["session_affinity"] != "true" {
		t.Fatalf("Bailian capabilities = vendor %q, cache %q, affinity %q", auth.Attributes["vendor"], auth.Attributes["cache_mode"], auth.Attributes["session_affinity"])
	}
	if _, ok := runtime.manager.Selector().(*coreauth.SessionAffinitySelector); !ok {
		t.Fatalf("credential selector = %T, want session affinity", runtime.manager.Selector())
	}

	models, source, err := runtime.DiscoverCredentialModels(context.Background(), "bailian")
	if err != nil {
		t.Fatal(err)
	}
	if source != "cpa_upstream" || strings.Join(models, ",") != "qwen-max,qwen-plus" {
		t.Fatalf("models = %v, source = %q", models, source)
	}
}

func TestRuntimeCredentialRefreshPreservesBailianSessionAffinity(t *testing.T) {
	credentials := []Credential{
		{ID: "bailian-a", Provider: "aliyun-bailian", Enabled: true, Models: []string{"qwen-plus"}, Document: []byte(`{"type":"openai-compatibility","api_key":"key-a","base_url":"https://example.test/v1"}`)},
		{ID: "bailian-b", Provider: "aliyun-bailian", Enabled: true, Models: []string{"qwen-plus"}, Document: []byte(`{"type":"openai-compatibility","api_key":"key-b","base_url":"https://example.test/v1"}`)},
	}
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, credentials)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	opts := cliproxyexecutor.Options{OriginalRequest: []byte(`{"model":"qwen-plus","messages":[{"role":"user","content":"stable session"}]}`)}
	first, errFirst := runtime.manager.SelectAuth(context.Background(), "openai-compatibility", "qwen-plus", opts)
	if errFirst != nil {
		t.Fatal(errFirst)
	}
	if errReplace := runtime.ReplaceCredentials(context.Background(), credentials); errReplace != nil {
		t.Fatal(errReplace)
	}
	second, errSecond := runtime.manager.SelectAuth(context.Background(), "openai-compatibility", "qwen-plus", opts)
	if errSecond != nil {
		t.Fatal(errSecond)
	}
	if first.ID != second.ID {
		t.Fatalf("session moved from %q to %q after credential refresh", first.ID, second.ID)
	}
}

func TestRuntimeRetriesSoleCredentialAfterShortTransientCooldown(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex-only", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	failedAt := time.Now()
	runtime.manager.MarkResult(context.Background(), coreauth.Result{
		AuthID: "codex-only", Provider: "codex", Model: "gpt-test",
		Error: &coreauth.Error{HTTPStatus: http.StatusServiceUnavailable, Message: "temporary upstream failure"},
	})
	auth, ok := runtime.manager.GetByID("codex-only")
	if !ok || auth.ModelStates["gpt-test"] == nil {
		t.Fatal("transient failure did not update model health")
	}
	retryAt := auth.ModelStates["gpt-test"].NextRetryAfter
	if delay := retryAt.Sub(failedAt); delay <= 0 || delay > 2*time.Second {
		t.Fatalf("transient retry delay = %v, want at most 2s", delay)
	}
	if wait := time.Until(retryAt.Add(25 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	picked, err := runtime.manager.SelectAuth(context.Background(), "codex", "gpt-test", cliproxyexecutor.Options{})
	if err != nil {
		t.Fatalf("sole credential was not retried: %v", err)
	}
	if picked.ID != "codex-only" {
		t.Fatalf("picked credential = %q, want codex-only", picked.ID)
	}

	quotaFailedAt := time.Now()
	quotaRetryAfter := 30 * time.Second
	runtime.manager.MarkResult(context.Background(), coreauth.Result{
		AuthID: "codex-only", Provider: "codex", Model: "gpt-test",
		RetryAfter: &quotaRetryAfter,
		Error:      &coreauth.Error{HTTPStatus: http.StatusTooManyRequests, Message: "quota exceeded"},
	})
	auth, _ = runtime.manager.GetByID("codex-only")
	state := auth.ModelStates["gpt-test"]
	if !state.Quota.Exceeded || state.NextRetryAfter.Sub(quotaFailedAt) < 29*time.Second {
		t.Fatalf("quota cooldown was shortened: %#v", state)
	}
}

func TestRuntimePrefersHealthyCredentialDuringTransientCooldown(t *testing.T) {
	credentials := []Credential{
		{ID: "codex-a", Provider: "codex", Enabled: true, Models: []string{"gpt-test"}, Document: []byte(`{"type":"codex","access_token":"token-a"}`)},
		{ID: "codex-b", Provider: "codex", Enabled: true, Models: []string{"gpt-test"}, Document: []byte(`{"type":"codex","access_token":"token-b"}`)},
	}
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, credentials)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	runtime.manager.MarkResult(context.Background(), coreauth.Result{
		AuthID: "codex-a", Provider: "codex", Model: "gpt-test",
		Error: &coreauth.Error{HTTPStatus: http.StatusServiceUnavailable, Message: "temporary upstream failure"},
	})
	picked, err := runtime.manager.SelectAuth(context.Background(), "codex", "gpt-test", cliproxyexecutor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if picked.ID != "codex-b" {
		t.Fatalf("picked credential = %q, want healthy codex-b", picked.ID)
	}
}

func TestRuntimeDisabledCredentialCoolingNeverBlackoutsAccount(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key", DisableCredentialCooling: true}, []Credential{{
		ID: "always-available", Provider: "codex", Enabled: true, Models: []string{"gpt-test"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	if !runtime.cfg.DisableCooling || runtime.cfg.TransientErrorCooldownSeconds != -1 {
		t.Fatalf("cooling config = disabled %v, transient %d", runtime.cfg.DisableCooling, runtime.cfg.TransientErrorCooldownSeconds)
	}

	retryAfter := 30 * time.Second
	for _, test := range []struct {
		name       string
		status     int
		retryAfter *time.Duration
	}{
		{name: "bad request", status: http.StatusBadRequest},
		{name: "quota", status: http.StatusTooManyRequests, retryAfter: &retryAfter},
		{name: "provider outage", status: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime.manager.MarkResult(context.Background(), coreauth.Result{
				AuthID: "always-available", Provider: "codex", Model: "gpt-test", RetryAfter: test.retryAfter,
				Error: &coreauth.Error{HTTPStatus: test.status, Message: http.StatusText(test.status)},
			})
			status, ok := runtime.CredentialStatus("always-available")
			if !ok || status.Unavailable || status.QuotaExceeded || !status.NextRetryAfter.IsZero() || !status.QuotaRecoverAt.IsZero() {
				t.Fatalf("credential entered cooldown: %+v", status)
			}
			selected, selectErr := runtime.manager.SelectAuth(context.Background(), "codex", "gpt-test", cliproxyexecutor.Options{})
			if selectErr != nil || selected.ID != "always-available" {
				t.Fatalf("credential was not immediately selectable: selected=%v err=%v", selected, selectErr)
			}
		})
	}
}

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
	if runtime.cfg.TransientErrorCooldownSeconds != transientCredentialCooldownSeconds {
		t.Fatalf("transient cooldown = %d, want %d", runtime.cfg.TransientErrorCooldownSeconds, transientCredentialCooldownSeconds)
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

func TestRuntimeLeavesWebSocketModelAliasesToCPAStateMachine(t *testing.T) {
	runtime, err := NewRuntime(Options{APIKey: "internal-test-key"}, []Credential{{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"public-model"},
		Document: []byte(`{"type":"codex","access_token":"secret","model_routes":[{"public":"public-model","upstream":"upstream-model"}]}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })

	request := pluginapi.ModelRouteRequest{
		RequestedModel: "public-model",
		Headers: http.Header{
			"Upgrade":             []string{"websocket"},
			"X-Relay-Cpa-Auth-Id": []string{"codex"},
		},
	}
	if response, handled := runtime.RouteModel(context.Background(), request); handled {
		t.Fatalf("websocket model alias was routed outside CPA state machine: %#v", response)
	}
	if got := runtime.ResolveCredentialModel("codex", "public-model"); got != "upstream-model" {
		t.Fatalf("resolved credential model = %q", got)
	}
}
