package app

import (
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestNativeProviderAccountOmitsEmptyDetails(t *testing.T) {
	result := nativeProviderAccount(store.UpstreamCredentialSnapshot{
		ID: "openai-test", Name: "Test", Provider: "openai", Enabled: true,
		Models: []string{"gpt-test"}, Document: []byte(`{"type":"openai"}`), Source: "import",
	})
	for _, key := range []string{"email", "base_url", "prefix", "auth_kind"} {
		if _, ok := result[key]; ok {
			t.Errorf("empty detail %q should be omitted", key)
		}
	}
}

func TestNativeProviderAccountInfersAPIKeyKind(t *testing.T) {
	result := nativeProviderAccount(store.UpstreamCredentialSnapshot{
		ID: "openai-test", Name: "Test", Provider: "openai", Enabled: true,
		Models: []string{"gpt-test"}, Document: []byte(`{"type":"openai","api_key":"secret"}`), Source: "native",
	})
	if got := result["auth_kind"]; got != "api_key" {
		t.Fatalf("auth_kind = %#v, want api_key", got)
	}
}
