package rai

import "testing"

func TestSelectDefaultModel(t *testing.T) {
	for _, test := range []struct {
		name               string
		models, candidates []string
		want               string
	}{
		{"preferred", []string{"codex-code-review", "grok-4.6", "gpt-5.6-sol"}, DefaultModelCandidates(), "gpt-5.6-sol"},
		{"second available", []string{"codex-code-review", "grok-4.6"}, DefaultModelCandidates(), "grok-4.6"},
		{"no match", []string{"codex-code-review"}, DefaultModelCandidates(), ""},
		{"no models", nil, DefaultModelCandidates(), ""},
		{"operator order", []string{"gpt-5.6-sol", "grok-4.6"}, []string{"grok-4.6", "gpt-5.6-sol"}, "grok-4.6"},
		{"custom model", []string{"custom"}, []string{"unavailable", "custom"}, "custom"},
		{"disabled", []string{"gpt-5.6-sol"}, []string{}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := SelectDefaultModel(test.models, test.candidates); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestResolveLaunchModelPriority(t *testing.T) {
	models := []string{"codex-code-review", "gpt-5.6-sol", "grok-4.6"}
	for _, test := range []struct {
		name, saved, requested, siteDefault, want string
	}{
		{"site", "", "", "gpt-5.6-sol", "gpt-5.6-sol"},
		{"site changed", "", "", "grok-4.6", "grok-4.6"},
		{"saved override", "grok-4.6", "", "gpt-5.6-sol", "grok-4.6"},
		{"explicit override", "grok-4.6", "gpt-5.6-sol", "grok-4.6", "gpt-5.6-sol"},
		{"no candidate", "", "", "", ""},
		{"unavailable default", "", "", "missing", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveLaunchModel(Profile{DefaultModel: test.saved}, test.requested, models, test.siteDefault)
			if test.want == "" {
				if err == nil {
					t.Fatal("expected model selection error")
				}
			} else if err != nil || got != test.want {
				t.Fatalf("got %q, %v; want %q", got, err, test.want)
			}
		})
	}
}
