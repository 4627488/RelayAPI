package app

import (
	"context"
	"testing"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestRAICodexContractCoversAllSelectableModels(t *testing.T) {
	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{
		{ID: "native", Provider: "codex", Enabled: true, Models: []string{"native-model"}, Document: []byte(`{"type":"codex","access_token":"test","websockets":true}`)},
		{ID: "chat", Provider: "openai-compatible", Enabled: true, Models: []string{"chat-model"}, Document: []byte(`{"type":"openai","api_key":"test","base_url":"https://example.invalid/v1"}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	a := &App{nativeRuntime: runtime, nativeCPA: &cpa.Client{}}
	a.nativeSettings.value = defaultNativeRuntimeSettings()
	a.nativeSettings.value.UpstreamWebSockets = true
	key := store.KeyContext{ModelAliases: []store.APIKeyModelAlias{{Alias: "alias", Model: "chat-model"}}}
	c := a.raiCodexCapabilities(key, []string{"native-model", "alias"})
	if c.Version != 1 || !c.WebSockets || !c.RemoteCompaction || c.StandaloneWebSearch {
		t.Fatalf("embedded adapter contract: %+v", c)
	}
	noWS := false
	a.setCapabilities(pricing.NewCapabilityIndex("admin", []pricing.Capability{{ID: "chat-model", Source: pricing.SourceAdmin, PreferWebSockets: &noWS}}))
	if a.raiCodexCapabilities(key, []string{"native-model", "alias"}).WebSockets {
		t.Fatal("admin transport veto ignored")
	}
	a.setCapabilities(nil)
	a.nativeCPA = nil
	c = a.raiCodexCapabilities(key, []string{"native-model", "alias"})
	if c.WebSockets || c.RemoteCompaction {
		t.Fatalf("native fallback advertised missing adaptation: %+v", c)
	}
}
