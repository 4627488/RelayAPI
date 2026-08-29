package app

import (
	"encoding/json"
	"strings"
	"testing"

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

func TestTenantAndKeyWriteJSONUsesSnakeCase(t *testing.T) {
	var tenant tenantInput
	if err := json.Unmarshal([]byte(`{
		"name":"demo",
		"owner_email":"demo@example.test",
		"password":"password1",
		"enabled":true,
		"model_allowlist":[]
	}`), &tenant); err != nil {
		t.Fatal(err)
	}
	if tenant.Name != "demo" || tenant.OwnerEmail != "demo@example.test" || !tenant.Enabled {
		t.Fatalf("tenant = %+v", tenant)
	}

	var key keyInput
	if err := json.Unmarshal([]byte(`{
		"name":"default",
		"enabled":true,
		"model_allowlist":[],
		"model_aliases":[]
	}`), &key); err != nil {
		t.Fatal(err)
	}
	if key.Name != "default" || !key.Enabled {
		t.Fatalf("key = %+v", key)
	}
}
