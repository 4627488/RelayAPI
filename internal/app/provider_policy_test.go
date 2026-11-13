package app

import "testing"

func TestOnlyCodexCredentialsAccepted(t *testing.T) {
	for _, provider := range []string{"codex", "kimi", "xai", "openai", "claude", "gemini", "cursor", "aliyun-bailian", "unknown"} {
		_, ok := normalizeSupportedProvider(provider)
		if ok != (provider == "codex") {
			t.Fatalf("provider %s: %v", provider, ok)
		}
	}
	for _, document := range []string{`{"type":"claude"}`, `{"type":"openai"}`, `invalid`} {
		if validateSupportedCredentialDocument("codex", []byte(document)) == nil {
			t.Fatalf("accepted %s", document)
		}
	}
	if err := validateSupportedCredentialDocument("codex", []byte(`{"type":"codex","access_token":"test"}`)); err != nil {
		t.Fatal(err)
	}
}
