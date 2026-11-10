package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/rai"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestClaudeCatalogDescribesAliasesAndBoundsContext(t *testing.T) {
	payload := []byte(`{"object":"list","data":[{"id":"gpt-main","unknown":"keep"},{"id":"claude-sonnet-4-6"},{"id":"friendly"},{"id":"claude-sonnet-5-5"},{"id":"claude-fake"}],"first_id":"gpt-main","last_id":"claude-fake"}`)
	info := map[string]rai.ModelInfo{
		"gpt-main":          {CanonicalModel: "gpt-main"},
		"claude-sonnet-4-6": {CanonicalModel: "claude-sonnet-4-6", Context: 1000000, MaxInput: 200000},
		"claude-sonnet-5-5": {CanonicalModel: "claude-sonnet-5-5", Context: 1000000, Name: "Sonnet", ToolSearch: boolPtr(true)},
		"friendly":          {CanonicalModel: "claude-opus-5-5", Context: 1000000},
		"claude-fake":       {CanonicalModel: "gpt-main"},
	}
	out, err := promoteClaudeCatalog(payload, info)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = json.Unmarshal(out, &doc)
	items := doc["data"].([]any)
	byID := map[string]map[string]any{}
	for _, raw := range items {
		m := raw.(map[string]any)
		byID[catalogModelID(m)] = m
	}
	if items[1].(map[string]any)["id"] != "claude-sonnet-5-5" {
		t.Fatalf("bad default: %s", out)
	}
	if byID["claude-sonnet-4-6"]["supports_1m"] != false || byID["claude-sonnet-4-6"]["max_input_tokens"] != float64(200000) {
		t.Fatal("input restriction lost")
	}
	if byID["friendly"]["behaves_as"] != "claude-opus-5-5" || byID["friendly"]["anthropic_family_tier"] != "opus" {
		t.Fatal("alias identity lost")
	}
	if byID["claude-sonnet-5-5"]["is_family_default"] != true {
		t.Fatal("missing family capability")
	}
	if byID["gpt-main"]["unknown"] != "keep" || byID["gpt-main"]["anthropic_family_tier"] != nil || byID["claude-fake"]["anthropic_family_tier"] != nil {
		t.Fatal("non-Claude metadata changed")
	}
}

func TestClaudeCatalogStaysAuthorizedAndInvalidatesOnCapabilityChange(t *testing.T) {
	models := []string{"claude-sonnet-4-6", "claude-opus-4-6"}
	a := newNativeRuntimeTestApp(t, upstream.Credential{ID: "claude-catalog", Provider: "openai", Enabled: true, Models: models, Document: []byte(`{"type":"openai","api_key":"test","base_url":"https://example.invalid/v1"}`)})
	key := store.KeyContext{TenantModels: []string{"claude-sonnet-4-6"}, ModelAliases: []store.APIKeyModelAlias{{Alias: "friendly", Model: "claude-sonnet-4-6"}, {Alias: "denied", Model: "claude-opus-4-6"}}}
	set := func(window int) {
		a.setCapabilities(pricing.NewCapabilityIndex("same", []pricing.Capability{{ID: "claude-sonnet-4-6", Provider: "anthropic", Context: window, Name: "Sonnet"}}))
	}
	set(200000)
	w := httptest.NewRecorder()
	a.serveModelCatalog(w, httptest.NewRequest("GET", "/v1/models", nil), key)
	if w.Code != 200 || strings.Contains(w.Body.String(), "claude-opus-4-6") || strings.Contains(w.Body.String(), `"id":"denied"`) {
		t.Fatalf("catalog policy escaped: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"behaves_as":"claude-sonnet-4-6"`) {
		t.Fatal("allowed alias lost")
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("If-None-Match", w.Header().Get("ETag"))
	set(1000000)
	changed := httptest.NewRecorder()
	a.serveModelCatalog(changed, req, key)
	if changed.Code != 200 || changed.Header().Get("ETag") == w.Header().Get("ETag") || !strings.Contains(changed.Body.String(), `"supports_1m":true`) {
		t.Fatal("capability change did not refresh discovery")
	}
}

func boolPtr(value bool) *bool { return &value }
