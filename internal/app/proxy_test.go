package app

import "testing"

func TestReadRequestMeta(t *testing.T) {
	tests := []struct{ body, path, model string }{
		{`{"model":"gpt-5.4","stream":true}`, "/v1/responses", "gpt-5.4"},
		{`{"contents":[]}`, "/v1beta/models/gemini-3.5-pro:generateContent", "gemini-3.5-pro"},
		{`{"contents":[]}`, "/v1beta/models/prefix%2Fmodel:streamGenerateContent", "prefix/model"},
	}
	for _, test := range tests {
		got := readRequestMeta([]byte(test.body), test.path)
		if got.Model != test.model {
			t.Errorf("model = %q, want %q", got.Model, test.model)
		}
	}
}

func TestAllowedSupportsGlob(t *testing.T) {
	if !allowed("claude-sonnet-4-6", []string{"claude-*"}) {
		t.Fatal("glob should match")
	}
	if allowed("gpt-5.4", []string{"claude-*"}) {
		t.Fatal("unexpected match")
	}
	if !allowed("anything", nil) {
		t.Fatal("empty allowlist should allow all")
	}
}
