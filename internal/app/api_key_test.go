package app

import (
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestNormalizeKeyInput(t *testing.T) {
	input := keyInput{
		Name:           " production ",
		ModelAllowlist: []string{"gpt-5.6", " GPT-5.6 ", "claude-*"},
		ModelAliases: []db.APIKeyModelAlias{
			{Alias: " FAST ", Model: "gpt-5.6"},
			{Alias: "sonnet", Model: "claude-sonnet-4-6"},
		},
	}
	if err := normalizeKeyInput(&input); err != nil {
		t.Fatal(err)
	}
	if input.Name != "production" || len(input.ModelAllowlist) != 2 || input.ModelAliases[0].Alias != "fast" {
		t.Fatalf("normalized input = %+v", input)
	}
}

func TestNormalizeKeyInputRejectsUnsafeAliases(t *testing.T) {
	for _, test := range []struct {
		name    string
		aliases []db.APIKeyModelAlias
		want    string
	}{
		{name: "duplicate", aliases: []db.APIKeyModelAlias{{Alias: "fast", Model: "gpt-5.6"}, {Alias: "FAST", Model: "gpt-5.6"}}, want: "重复"},
		{name: "self", aliases: []db.APIKeyModelAlias{{Alias: "gpt-5.6", Model: "gpt-5.6"}}, want: "自身"},
		{name: "outside allowlist", aliases: []db.APIKeyModelAlias{{Alias: "sonnet", Model: "claude-sonnet"}}, want: "不在已启用模型"},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := keyInput{Name: "key", ModelAllowlist: []string{"gpt-5.6"}, ModelAliases: test.aliases}
			err := normalizeKeyInput(&input)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestParseOptionalExpiry(t *testing.T) {
	if got, err := parseOptionalExpiry(""); err != nil || got != nil {
		t.Fatalf("empty = %v, %v", got, err)
	}
	if _, err := parseOptionalExpiry("not-a-date"); err == nil {
		t.Fatal("expected invalid format")
	}
	if _, err := parseOptionalExpiry(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)); err == nil {
		t.Fatal("expected past expiry to fail")
	}
	want := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	got, err := parseOptionalExpiry(want.Format(time.RFC3339))
	if err != nil || got == nil || !got.Equal(want) {
		t.Fatalf("future = %v, %v want %v", got, err, want)
	}
}
