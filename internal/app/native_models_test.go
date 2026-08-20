package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestFilterModelCatalogPreservesEnvelopeFormats(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		key     string
		wantID  string
	}{
		{"openai", `{"object":"list","data":[{"id":"public-model"},{"id":"private-model"}]}`, "data", "public-model"},
		{"codex", `{"models":[{"slug":"public-model"},{"slug":"private-model"}]}`, "models", "public-model"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := filterModelCatalog([]byte(test.payload), []string{"public-model"})
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(payload, &document); err != nil {
				t.Fatal(err)
			}
			items, _ := document[test.key].([]any)
			if len(items) != 1 {
				t.Fatalf("items = %#v", items)
			}
			item, _ := items[0].(map[string]any)
			if got := catalogModelID(item); got != test.wantID {
				t.Fatalf("id = %q, want %q", got, test.wantID)
			}
		})
	}
}

func TestAddCodexModelAliases(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"grok-4.5","display_name":"Grok 4.5","context_window":131072,"visibility":"list"},
		{"slug":"qwen-max","display_name":"Qwen Max","visibility":"list"}
	]}`)
	filtered, err := filterModelCatalog(payload, []string{"grok-4.5"})
	if err != nil {
		t.Fatal(err)
	}
	expanded, err := addCodexModelAliases(filtered, []store.APIKeyModelAlias{
		{Alias: "gpt-5.6-sol", Model: "grok-4.5"},
		{Alias: "missing", Model: "qwen-max"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(expanded, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	alias, _ := items[1].(map[string]any)
	if got := catalogModelID(alias); got != "gpt-5.6-sol" {
		t.Fatalf("alias slug = %q", got)
	}
	if got := alias["context_window"]; got != float64(131072) {
		t.Fatalf("alias context_window = %#v", got)
	}
	if got := alias["description"]; got != "RelayAPI 模型别名，映射到 grok-4.5" {
		t.Fatalf("alias description = %#v", got)
	}
}

func TestFilterCodexCatalogHidesDeniedModelsInsteadOfDroppingThem(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"public-model","visibility":"list","context_window":1000},
		{"slug":"private-model","visibility":"list","context_window":2000}
	]}`)
	filtered, err := filterModelCatalogForClient(payload, []string{"public-model"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(filtered, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	private, _ := items[1].(map[string]any)
	if private["visibility"] != "hide" {
		t.Fatalf("private model visibility = %#v, want hide", private["visibility"])
	}
	if private["context_window"] != float64(2000) {
		t.Fatal("hidden override discarded capability metadata")
	}
}

func TestPromoteCodexCatalogCapabilitiesAdvertisesFullAgentSurface(t *testing.T) {
	payload := []byte(`{"models":[{"slug":"qwen-max","visibility":"list"},{"slug":"private","visibility":"hide"},{"slug":"gpt-image-1.5","visibility":"list"}]}`)
	promoted, err := promoteCodexCatalogCapabilities(payload, nil)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(promoted, &document); err != nil {
		t.Fatal(err)
	}
	items := document["models"].([]any)
	model := items[0].(map[string]any)
	assertCodexModelInfoComplete(t, model)
	if model["display_name"] != "Qwen Max" || model["visibility"] != "list" {
		t.Fatalf("visible model identity = %#v", model)
	}
	hidden := items[1].(map[string]any)
	assertCodexModelInfoComplete(t, hidden)
	if hidden["visibility"] != "hide" {
		t.Fatalf("hidden tombstone visibility = %#v", hidden["visibility"])
	}
	image := items[2].(map[string]any)
	if image["visibility"] != "hide" {
		t.Fatalf("image-only model stayed visible: %#v", image)
	}
	assertCodexModelInfoComplete(t, image)
}

func TestPromoteOverlaysModelsDevCapabilities(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"kimi-k3","visibility":"list"},
		{"slug":"kimi-k2.5","visibility":"list"},
		{"slug":"gpt-5.4","visibility":"list"}
	]}`)
	index := pricing.NewCapabilityIndex("sha256:test", []pricing.Capability{
		{
			ID: "moonshotai/kimi-k3", Name: "Kimi K3", Provider: "moonshotai", Context: 1048576, MaxOutput: 65536,
			Reasoning: true, ReasoningOptions: []pricing.ReasoningOption{{Type: "effort", Values: []string{"low", "high", "max"}}},
			InputModalities: []string{"text", "image"},
		},
		{
			ID: "moonshotai/kimi-k2.5", Name: "Kimi K2.5", Provider: "moonshotai", Context: 262144, MaxOutput: 32768,
			Reasoning: true, ReasoningOptions: []pricing.ReasoningOption{{Type: "toggle"}},
			InputModalities: []string{"text", "image"},
		},
		{
			ID: "openai/gpt-5.4", Name: "GPT-5.4", Provider: "openai", Context: 1050000,
			Reasoning: true, ReasoningOptions: []pricing.ReasoningOption{{Type: "effort", Values: []string{"none", "low", "medium", "high", "xhigh"}}},
		},
	})
	promoted, err := promoteCodexCatalogCapabilities(payload, index)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(promoted, &document); err != nil {
		t.Fatal(err)
	}
	got := map[string]map[string]any{}
	for _, raw := range document["models"].([]any) {
		item := raw.(map[string]any)
		got[catalogModelID(item)] = item
	}
	k3 := got["kimi-k3"]
	assertCodexModelInfoComplete(t, k3)
	if k3["context_window"] != float64(1048576) || k3["max_context_window"] != float64(1048576) || k3["max_output_tokens"] != float64(65536) {
		t.Fatalf("kimi-k3 windows = %#v", k3)
	}
	if k3["prefer_websockets"] != false || k3["support_verbosity"] != false || k3["multi_agent_version"] != nil {
		t.Fatalf("kimi-k3 should not advertise Responses-only transport: %#v", k3)
	}
	if k3["apply_patch_tool_type"] != "freeform" {
		t.Fatalf("models.dev overlay deleted apply_patch: %#v", k3["apply_patch_tool_type"])
	}
	assertReasoningEfforts(t, k3, []string{"low", "high", "max"}, "high")

	k25 := got["kimi-k2.5"]
	assertCodexModelInfoComplete(t, k25)
	assertReasoningEfforts(t, k25, []string{"none", "high"}, "high")
	if k25["prefer_websockets"] != false {
		t.Fatalf("kimi-k2.5 prefer_websockets = %#v", k25["prefer_websockets"])
	}

	gpt := got["gpt-5.4"]
	assertCodexModelInfoComplete(t, gpt)
	if gpt["context_window"] != float64(262144) {
		t.Fatalf("official OpenAI slug was overlaid: context=%#v", gpt["context_window"])
	}
	assertReasoningEfforts(t, gpt, []string{"none", "low", "medium", "high"}, "medium")
}

func TestPromoteOverlaysAdminKimiK3256k(t *testing.T) {
	payload := []byte(`{"models":[{"slug":"kimi-k3-256k","visibility":"list"}]}`)
	preferWS := false
	index := pricing.NewCapabilityIndex("admin", []pricing.Capability{{
		ID: "kimi-k3-256k", Name: "Kimi K3 256k", Provider: "moonshotai", Source: pricing.SourceAdmin,
		Context: 262144, MaxOutput: 131072, Reasoning: true, DefaultLevel: "max",
		ReasoningOptions: []pricing.ReasoningOption{{Type: "effort", Values: []string{"low", "high", "max"}}},
		InputModalities:  []string{"text", "image"}, PreferWebSockets: &preferWS,
	}})
	promoted, err := promoteCodexCatalogCapabilities(payload, index)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(promoted, &document); err != nil {
		t.Fatal(err)
	}
	item := document["models"].([]any)[0].(map[string]any)
	assertCodexModelInfoComplete(t, item)
	if item["display_name"] != "Kimi K3 256k" {
		t.Fatalf("display_name = %#v", item["display_name"])
	}
	if item["context_window"] != float64(262144) || item["max_output_tokens"] != float64(131072) {
		t.Fatalf("windows = %#v", item)
	}
	if item["prefer_websockets"] != false {
		t.Fatalf("prefer_websockets = %#v", item["prefer_websockets"])
	}
	assertReasoningEfforts(t, item, []string{"low", "high", "max"}, "max")
}

func assertReasoningEfforts(t *testing.T, model map[string]any, want []string, defaultLevel string) {
	t.Helper()
	if model["default_reasoning_level"] != defaultLevel {
		t.Fatalf("default_reasoning_level = %#v, want %q", model["default_reasoning_level"], defaultLevel)
	}
	levels, _ := model["supported_reasoning_levels"].([]any)
	got := make([]string, 0, len(levels))
	for _, raw := range levels {
		level, _ := raw.(map[string]any)
		effort, _ := level["effort"].(string)
		got = append(got, effort)
	}
	if len(got) != len(want) {
		t.Fatalf("reasoning efforts = %#v, want %#v", got, want)
	}
	for i, effort := range want {
		if got[i] != effort {
			t.Fatalf("reasoning efforts = %#v, want %#v", got, want)
		}
	}
}

func assertCodexModelInfoComplete(t *testing.T, model map[string]any) {
	t.Helper()
	if catalogModelID(model) == "" {
		t.Fatalf("slug missing: %#v", model)
	}
	if model["display_name"] == nil || model["display_name"] == "" || model["description"] == nil || model["description"] == "" {
		t.Fatalf("identity missing: %#v", model)
	}
	if model["shell_type"] != "shell_command" || model["supported_in_api"] != true {
		t.Fatalf("required picker fields = %#v", model)
	}
	if model["default_reasoning_level"] == nil || model["default_reasoning_level"] == "" {
		t.Fatalf("default_reasoning_level missing: %#v", model)
	}
	levels, _ := model["supported_reasoning_levels"].([]any)
	if len(levels) == 0 {
		t.Fatalf("supported_reasoning_levels = %#v", model["supported_reasoning_levels"])
	}
	if model["max_context_window"] == nil || model["context_window"] == nil {
		t.Fatalf("context windows missing: %#v", model)
	}
	if model["apply_patch_tool_type"] != "freeform" {
		t.Fatalf("apply_patch_tool_type = %#v", model["apply_patch_tool_type"])
	}
	if model["web_search_tool_type"] != "text" && model["web_search_tool_type"] != "text_and_image" {
		t.Fatalf("web_search_tool_type = %#v", model["web_search_tool_type"])
	}
	for _, key := range []string{"supports_parallel_tool_calls", "supports_search_tool", "supports_reasoning_summary_parameter"} {
		if model[key] != true {
			t.Fatalf("%s = %#v, want true", key, model[key])
		}
	}
	if model["base_instructions"] == nil || model["base_instructions"] == "" {
		t.Fatal("base_instructions missing")
	}
	policy, _ := model["truncation_policy"].(map[string]any)
	if policy["mode"] == nil || policy["limit"] == nil {
		t.Fatalf("truncation_policy = %#v", model["truncation_policy"])
	}
}

func TestModelCatalogRevisionIsStableAndPermissionScoped(t *testing.T) {
	first := store.KeyContext{
		APIKey: store.APIKey{
			ModelAllowlist: []string{"model-b", "model-a"},
			ModelAliases:   []store.APIKeyModelAlias{{Alias: "alias-b", Model: "model-b"}, {Alias: "alias-a", Model: "model-a"}},
		},
	}
	second := first
	second.ModelAliases = []store.APIKeyModelAlias{{Alias: "alias-a", Model: "model-a"}, {Alias: "alias-b", Model: "model-b"}}
	left := modelCatalogRevision(first, []string{"model-b", "private", "model-a"}, "")
	right := modelCatalogRevision(second, []string{"model-a", "model-b", "private"}, "")
	if left != right {
		t.Fatalf("equivalent catalogs produced different revisions: %q != %q", left, right)
	}
	if !etagMatches("W/"+left, left) {
		t.Fatal("weak If-None-Match value did not match the current revision")
	}
	second.ModelAliases = append(second.ModelAliases, store.APIKeyModelAlias{Alias: "new", Model: "model-a"})
	if changed := modelCatalogRevision(second, []string{"model-a", "model-b", "private"}, ""); changed == left {
		t.Fatal("alias change did not invalidate the catalog revision")
	}
}

func TestRetiredProtocolPathsAreRejectedBeforeAuthentication(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/messages/count_tokens", "/v1beta/models/gemini:generateContent"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, nil)
			recorder := httptest.NewRecorder()
			new(App).handlePublic(recorder, request)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			errorObject, _ := payload["error"].(map[string]any)
			if errorObject["code"] != "unsupported_protocol" {
				t.Fatalf("error = %#v", payload)
			}
		})
	}
}

func TestAddCodexModelAliasesReplacesCollidingCatalogEntry(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","context_window":1000},
		{"slug":"grok-4.5","display_name":"Grok 4.5","context_window":2000}
	]}`)
	expanded, err := addCodexModelAliases(payload, []store.APIKeyModelAlias{{Alias: "gpt-5.6-sol", Model: "grok-4.5"}})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(expanded, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	alias, _ := items[0].(map[string]any)
	if got := alias["context_window"]; got != float64(2000) {
		t.Fatalf("colliding alias did not inherit target metadata: %#v", alias)
	}
}

func TestServeModelCatalogReturnsAuthorizedCodexCatalogAndAliases(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{
		ID: "codex-catalog", Provider: "codex", Enabled: true,
		Models:   []string{"grok-4.5", "subscription-model", "private-model"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.147.0", nil)
	request.Header.Set("User-Agent", "codex-tui/0.147.0")
	recorder := httptest.NewRecorder()
	key := store.KeyContext{TenantModels: []string{"grok-4.5"}}
	key.ModelAllowlist = []string{"grok-4.5", "subscription-model"}
	key.SubscriptionModelGrants = []store.SubscriptionModelGrant{{UpstreamModels: []string{"subscription-model"}}}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "gpt-5.6-sol", Model: "grok-4.5"}}

	app.serveModelCatalog(recorder, request, key)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	got := make(map[string]map[string]any, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		got[catalogModelID(item)] = item
	}
	if got["grok-4.5"] == nil || got["gpt-5.6-sol"] == nil || got["subscription-model"] == nil {
		t.Fatalf("catalog slugs = %#v", got)
	}
	if got["private-model"] == nil || got["private-model"]["visibility"] != "hide" {
		t.Fatal("catalog did not hide the model outside the key and tenant allowlists")
	}
	if got["gpt-image-2"] == nil || got["gpt-image-2"]["visibility"] != "hide" ||
		got["gpt-image-1.5"] == nil || got["gpt-image-1.5"]["visibility"] != "hide" {
		t.Fatal("implicit Codex image slugs must stay hidden in the picker")
	}
	assertCodexModelInfoComplete(t, got["grok-4.5"])
	assertCodexModelInfoComplete(t, got["gpt-5.6-sol"])
	assertCodexModelInfoComplete(t, got["private-model"])
	if got["gpt-5.6-sol"]["context_window"] != got["grok-4.5"]["context_window"] {
		t.Fatal("alias did not inherit target model metadata")
	}
	if got["gpt-5.6-sol"]["supported_reasoning_levels"] == nil || got["private-model"]["base_instructions"] == nil {
		t.Fatal("alias or hidden override dropped Codex ModelInfo fields")
	}
	if recorder.Header().Get("ETag") == "" {
		t.Fatal("Codex model catalog did not include an ETag")
	}
	if got["grok-4.5"]["prefer_websockets"] != true {
		t.Fatalf("default catalog should keep websockets when the runtime allows them: %#v", got["grok-4.5"]["prefer_websockets"])
	}
}

func TestApplyCodexCatalogWebSocketPolicyDisablesTransport(t *testing.T) {
	t.Parallel()
	payload := []byte(`{"models":[{"slug":"gpt-5.4","prefer_websockets":true},{"slug":"kimi-k3","prefer_websockets":false}]}`)
	unchanged, err := applyCodexCatalogWebSocketPolicy(payload, true)
	if err != nil || string(unchanged) != string(payload) {
		t.Fatalf("enabled policy mutated catalog: %s %v", unchanged, err)
	}
	disabled, err := applyCodexCatalogWebSocketPolicy(payload, false)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(disabled, &document); err != nil {
		t.Fatal(err)
	}
	for _, raw := range document["models"].([]any) {
		item := raw.(map[string]any)
		if item["prefer_websockets"] != false {
			t.Fatalf("item = %#v", item)
		}
	}
}

func TestServeModelCatalogDisablesWebSocketsWhenRuntimePolicyIsOff(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{
		ID: "codex-catalog", Provider: "codex", Enabled: true,
		Models:   []string{"gpt-5.4"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	app.cfg.UpstreamWebSockets = false
	request := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.147.0", nil)
	recorder := httptest.NewRecorder()
	app.serveModelCatalog(recorder, request, store.KeyContext{TenantModels: []string{"gpt-5.4"}})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	var item map[string]any
	for _, raw := range document["models"].([]any) {
		candidate, _ := raw.(map[string]any)
		if catalogModelID(candidate) == "gpt-5.4" {
			item = candidate
			break
		}
	}
	if item == nil || item["prefer_websockets"] != false {
		t.Fatalf("gpt-5.4 = %#v", item)
	}
}
