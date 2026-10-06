package app

import "testing"

func TestNormalizeSupportedProviderMatchesCPABuiltins(t *testing.T) {
	for input, want := range map[string]string{
		"codex": "codex", "kimi": "kimi", "grok": "xai", "x.ai": "xai",
		"openai-compatible": "openai-compatibility", "百炼": "aliyun-bailian",
		"anthropic": "claude", "claude": "claude", "gemini": "gemini",
		"antigravity": "antigravity", "vertex": "vertex", "aistudio": "aistudio",
		"gemini-interactions-api-key": "gemini-interactions", "devin": "devin", "muse": "meta",
	} {
		got, ok := normalizeSupportedProvider(input)
		if !ok || got != want {
			t.Fatalf("normalizeSupportedProvider(%q) = (%q, %v), want (%q, true)", input, got, ok, want)
		}
	}
	for _, input := range []string{"unknown", "", "plugin-not-installed"} {
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
		{"claude", `{"type":"anthropic"}`},
		{"gemini", `{"type":"gemini-api-key"}`},
		{"meta", `{"type":"muse"}`},
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
