package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestCanonicalModelIDsUseAuthorsAndPreserveSpelling(t *testing.T) {
	a := &App{}
	a.setCapabilities(pricing.NewCapabilityIndex("ids", []pricing.Capability{
		{ID: "alibaba/Qwen-Test", Provider: "alibaba"},
		{ID: "openrouter/custom", Provider: "openrouter"},
		{ID: "mistral/codestral-test", Provider: "mistral"},
	}))
	for model, want := range map[string]string{
		"gpt-5.4": "openai/gpt-5.4", "o3": "openai/o3", "grok-test": "x-ai/grok-test",
		"kimi-k2.5": "moonshotai/kimi-k2.5", "gemini-test": "google/gemini-test",
		"claude-test:variant": "anthropic/claude-test:variant", "deepseek-test-20261022": "deepseek/deepseek-test-20261022",
		"Qwen-Test": "qwen/Qwen-Test", "codestral-test": "mistralai/codestral-test",
		"vendor/custom/model": "vendor/custom/model", "custom": "custom", "unknown": "unknown",
	} {
		if got := a.canonicalModelID(model); got != want {
			t.Errorf("%s => %s, want %s", model, got, want)
		}
	}
}

func modelIDTestApp(t *testing.T, models ...string) *App {
	t.Helper()
	return newNativeRuntimeTestApp(t, upstream.Credential{ID: "ids", Provider: "codex", Enabled: true, Models: models, Document: []byte(`{"type":"codex","access_token":"test"}`)})
}

func TestCanonicalIDsResolveBeforePermissionsAndPreserveAliasOwnership(t *testing.T) {
	a := modelIDTestApp(t, "gpt-test", "grok-test", "unknown")
	key := store.KeyContext{TenantModels: []string{"gpt-test"}}
	for _, id := range []string{"gpt-test", "openai/gpt-test"} {
		meta := a.resolveClientModel(id, key)
		if meta.Model != "gpt-test" || !key.AllowsModel(meta.Model) {
			t.Fatalf("compatibility: %+v", meta)
		}
	}
	if meta := a.resolveClientModel("x-ai/grok-test", key); meta.Model != "grok-test" || key.AllowsModel(meta.Model) {
		t.Fatalf("normalized ID bypassed policy: %+v", meta)
	}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "openai/gpt-test", Model: "unknown"}, {Alias: "fast", Model: "x-ai/grok-test"}}
	if got := a.resolveClientModel("openai/gpt-test", key); got.Model != "unknown" {
		t.Fatalf("overrode user alias: %+v", got)
	}
	if got := a.resolveClientModel("fast", key); got.Model != "grok-test" {
		t.Fatalf("canonical alias target not resolved: %+v", got)
	}
	visible := a.raiSessionModels(store.KeyContext{TenantModels: []string{"gpt-test"}})
	if strings.Join(visible, ",") != "gpt-test,openai/gpt-test" {
		t.Fatalf("rai lost legacy or normalized ID: %v", visible)
	}
	if key.ModelAliases[1].Model != "x-ai/grok-test" {
		t.Fatal("mutated shared Key aliases")
	}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "gpt-test", Model: "unknown"}}
	if got := a.resolveClientModel("openai/gpt-test", key); got.Model != "openai/gpt-test" {
		t.Fatalf("generated an ID for a shadowed model: %+v", got)
	}
	collision := modelIDTestApp(t, "gpt-test", "openai/gpt-test")
	if got := collision.resolveClientModel("openai/gpt-test", store.KeyContext{}); got.Model != "openai/gpt-test" || got.ModelAlias != "" {
		t.Fatalf("shadowed runtime ID: %+v", got)
	}
}

func TestCanonicalModelMetadataAndLegacyDetails(t *testing.T) {
	a := modelIDTestApp(t, "gpt-test", "grok-test", "unknown")
	key := store.KeyContext{TenantModels: []string{"gpt-test", "unknown"}}
	for _, prefix := range []string{"/v1/models", "/openai/v1/models", "/v1beta/models", "/backend-api/codex/models"} {
		for _, query := range []string{"", "?client_version=0.163.0"} {
			if prefix == "/v1beta/models" && query != "" {
				continue
			}
			recorder := httptest.NewRecorder()
			a.serveModelCatalog(recorder, httptest.NewRequest(http.MethodGet, prefix+query, nil), key)
			if query != "" && recorder.Header().Get("ETag") != modelCatalogRevision(a.modelIDKey(key), a.nativeRuntime.Models(), a.codexCatalogRevisionToken()) {
				t.Fatal("metadata and inference catalog revisions diverged")
			}
			if recorder.Code != 200 {
				t.Fatalf("%s: %d %s", prefix, recorder.Code, recorder.Body.String())
			}
			var doc map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &doc); err != nil {
				t.Fatal(err)
			}
			field := "data"
			if _, ok := doc["models"]; ok {
				field = "models"
			}
			items := map[string]map[string]any{}
			for _, raw := range doc[field].([]any) {
				item := raw.(map[string]any)
				items[strings.TrimPrefix(catalogModelID(item), "models/")] = item
			}
			canonical := items["openai/gpt-test"]
			if canonical == nil || canonical["canonical_slug"] != "openai/gpt-test" || canonical["visibility"] == "hide" {
				t.Fatalf("missing canonical metadata: %s", recorder.Body.String())
			}
			if items["x-ai/grok-test"] != nil {
				t.Fatalf("denied ID published: %s", recorder.Body.String())
			}
			if query == "" && items["gpt-test"] != nil {
				t.Fatalf("legacy duplicated standard list: %s", recorder.Body.String())
			}
			if query != "" && items["gpt-test"]["visibility"] != "hide" {
				t.Fatalf("legacy Codex ID not hidden: %s", recorder.Body.String())
			}
			if items["unknown"] == nil {
				t.Fatal("unknown model renamed")
			}
		}
		for _, id := range []string{"gpt-test", "openai/gpt-test"} {
			r := httptest.NewRecorder()
			a.serveModelCatalog(r, httptest.NewRequest(http.MethodGet, prefix+"/"+id, nil), key)
			var item map[string]any
			_ = json.Unmarshal(r.Body.Bytes(), &item)
			if r.Code != 200 || strings.TrimPrefix(catalogModelID(item), "models/") != id {
				t.Fatalf("legacy/canonical detail: %d %s", r.Code, r.Body.String())
			}
		}
		r := httptest.NewRecorder()
		a.serveModelCatalog(r, httptest.NewRequest(http.MethodGet, prefix+"/x-ai/grok-test", nil), key)
		if r.Code != http.StatusForbidden {
			t.Fatalf("canonical metadata bypassed policy: %d", r.Code)
		}
	}
}

func TestCanonicalIDWebSocketRewritesEveryTurn(t *testing.T) {
	a := modelIDTestApp(t, "gpt-test")
	key := store.KeyContext{TenantModels: []string{"gpt-test"}}
	accounting := &nativeWebSocketAccounting{admission: store.Admission{UpstreamCredentialID: "ids"}, currentMeta: requestMeta{Model: "gpt-test", RequestedModel: "gpt-test", Stream: true}}
	for _, id := range []string{"openai/gpt-test", "gpt-test"} {
		payload, _ := json.Marshal(map[string]string{"type": "response.create", "model": id})
		forwarded, meta, turn, err := a.prepareNativeWebSocketRequest(payload, httptest.NewRequest(http.MethodPost, "/v1/responses", nil), key, accounting)
		var body map[string]any
		_ = json.Unmarshal(forwarded, &body)
		if err != nil || !turn || meta.Model != "gpt-test" || body["model"] != "gpt-test" {
			t.Fatalf("WS normalization: %s %+v %v", forwarded, meta, err)
		}
	}
}
