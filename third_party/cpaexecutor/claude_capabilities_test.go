package relaybridge

import (
	"testing"
)

func TestNativeClaudeCapabilitiesRemainVisibleThroughObserver(t *testing.T) {
	for _, tc := range []struct {
		name, extra string
		want        bool
	}{
		{"anthropic", ``, true},
		{"unverified-custom", `,"base_url":"https://gateway.example"`, false},
		{"verified-custom", `,"base_url":"https://gateway.example","native_tool_search":true`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := NewRuntime(Options{APIKey: "test"}, []Credential{{ID: "claude-capabilities", Provider: "claude", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: []byte(`{"type":"claude","api_key":"test"` + tc.extra + `}`)}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = r.Close(t.Context()) })
			model, search, ok := r.NativeClaudeCapabilities("claude-sonnet-4-6")
			if !ok || model != "claude-sonnet-4-6" || search != tc.want {
				t.Fatalf("model=%s search=%v native=%v", model, search, ok)
			}
			if _, _, ok := r.NativeClaudeCapabilities("missing"); ok {
				t.Fatal("invented capability for unknown model")
			}
		})
	}
}

func TestMixedProviderClaudeNamesDoNotAdvertiseNativeCapabilities(t *testing.T) {
	r, err := NewRuntime(Options{APIKey: "test"}, []Credential{
		{ID: "native-claude", Provider: "claude", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: []byte(`{"type":"claude","api_key":"test"}`)},
		{ID: "compatible", Provider: "openai", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: []byte(`{"type":"openai","api_key":"test","base_url":"https://example.invalid/v1"}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(t.Context()) })
	if _, _, ok := r.NativeClaudeCapabilities("claude-sonnet-4-6"); ok {
		t.Fatal("ambiguous mixed-provider route was advertised as native Claude")
	}
}
