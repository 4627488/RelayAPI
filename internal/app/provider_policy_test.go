package app

import "testing"

func TestNormalizeSupportedProviderIsFocused(t *testing.T) {
	for input, want := range map[string]string{
		"codex": "codex", "kimi": "kimi", "grok": "xai", "x.ai": "xai",
		"openai-compatible": "openai-compatibility", "百炼": "aliyun-bailian",
	} {
		got, ok := normalizeSupportedProvider(input)
		if !ok || got != want {
			t.Fatalf("normalizeSupportedProvider(%q) = (%q, %v), want (%q, true)", input, got, ok, want)
		}
	}
	for _, input := range []string{"claude", "anthropic", "gemini", "antigravity", "vertex"} {
		if got, ok := normalizeSupportedProvider(input); ok {
			t.Fatalf("normalizeSupportedProvider(%q) = %q, want unsupported", input, got)
		}
	}
}

func TestValidateSupportedCredentialDocumentRejectsExecutorEscape(t *testing.T) {
	valid := []struct {
		provider string
		document string
	}{
		{"codex", `{"type":"codex"}`},
		{"aliyun-bailian", `{"type":"openai-compatibility"}`},
		{"aliyun-bailian", `{"type":"aliyun-bailian"}`},
		{"openai", `{"type":"openai-compatibility"}`},
	}
	for _, test := range valid {
		if err := validateSupportedCredentialDocument(test.provider, []byte(test.document)); err != nil {
			t.Fatalf("valid %s credential rejected: %v", test.provider, err)
		}
	}
	for _, test := range []struct {
		provider string
		document string
	}{
		{"codex", `{"type":"claude"}`},
		{"xai", `{"type":"gemini"}`},
		{"kimi", `{"type":"codex"}`},
	} {
		if err := validateSupportedCredentialDocument(test.provider, []byte(test.document)); err == nil {
			t.Fatalf("executor escape %s/%s was accepted", test.provider, test.document)
		}
	}
}
