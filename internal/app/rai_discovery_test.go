package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestRAIDiscoveryDocument(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "version"), []byte("sha-test"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{cfg: config.Config{PublicURL: "https://relay.example", RAIBinDir: dir}}
	recorder := httptest.NewRecorder()
	app.raiDiscovery(recorder, httptest.NewRequest(http.MethodGet, "/.well-known/rai.json", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if document["kind"] != "rai.dev/v1" || document["api_base"] != "https://relay.example" {
		t.Fatalf("document = %#v", document)
	}
	if document["session"] != "/api/rai/session" {
		t.Fatalf("session = %#v", document["session"])
	}
	if document["authorization"] != "/api/rai/authorizations" || document["token"] != "/api/rai/token" {
		t.Fatalf("auth endpoints = %#v", document)
	}
	if document["install"] != "/rai/install.sh" {
		t.Fatalf("install = %#v", document["install"])
	}
	if document["download"] != "/rai/download" {
		t.Fatalf("download = %#v", document["download"])
	}
	if document["rai_version"] != "sha-test" {
		t.Fatalf("rai_version = %#v", document["rai_version"])
	}
}

func TestRAIModelInfoUsesAuthorizedIDsAndTrustedFacts(t *testing.T) {
	app := &App{}
	tools := true
	app.capabilities.Store(pricing.NewCapabilityIndex("test", []pricing.Capability{
		{ID: "vendor/model", Provider: "vendor", Name: "Model", Context: 100000, ToolCall: &tools, Reasoning: true, InputModalities: []string{"text", "image"}},
		{ID: "gpt-test", Provider: "aggregator", Context: 999999},
		{ID: "denied", Provider: "vendor", Context: 999999},
	}))
	key := store.KeyContext{APIKey: store.APIKey{ModelAliases: []store.APIKeyModelAlias{{Alias: "friendly", Model: "vendor/model"}}}}
	info := app.raiModelInfo(key, []string{"friendly", "gpt-test"})
	if len(info) != 2 || info["friendly"].Context != 100000 || info["friendly"].Reasoning == nil || !*info["friendly"].Reasoning {
		t.Fatalf("authorized alias facts missing: %#v", info)
	}
	if info["gpt-test"].Context != 0 {
		t.Fatal("untrusted aggregator overwrote OpenAI facts")
	}
	if _, exists := info["denied"]; exists {
		t.Fatal("model facts leaked outside allowed IDs")
	}
}
