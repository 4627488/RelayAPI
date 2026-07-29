package app

import (
	"encoding/json"
	"testing"
)

func TestProviderConfigAccounts(t *testing.T) {
	payload := []byte(`{
		"codex-api-key": [{
			"api-key": "secret",
			"auth-index": "codex-key-1",
			"prefix": "team-a",
			"base-url": "https://api.openai.com/v1",
			"models": [{"name": "gpt-5.2", "alias": "codex"}, "gpt-5-mini"]
		}],
		"openai-compatibility": [{
			"name": "openrouter",
			"base-url": "https://openrouter.ai/api/v1",
			"disabled": true,
			"api-key-entries": [{"api-key": "one"}, {"api-key": "two"}],
			"models": [{"name": "upstream/model", "alias": "public-model"}]
		}]
	}`)
	accounts, err := providerConfigAccounts(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 2 {
		t.Fatalf("accounts = %+v", accounts)
	}
	codex := accounts[0]
	if codex.Name != "config:codex-api-key:0" || codex.AuthIndex != "codex-key-1" ||
		codex.Label != "team-a" || codex.KeyCount != 1 || len(codex.Models) != 2 {
		t.Fatalf("codex account = %+v", codex)
	}
	compatible := accounts[1]
	if compatible.Label != "openrouter" || !compatible.Disabled || compatible.KeyCount != 2 ||
		!compatible.CanToggle || len(compatible.Models) != 1 || compatible.Models[0] != "public-model" {
		t.Fatalf("compatible account = %+v", compatible)
	}
	encoded, err := json.Marshal(accounts)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) == "" || containsSecret(string(encoded), "secret", "one", "two") {
		t.Fatalf("serialized accounts leaked API keys: %s", encoded)
	}
}

func TestDecodeProviderAccounts(t *testing.T) {
	accounts, err := decodeProviderAccounts([]byte(`{"files":[{
		"name":"codex-user.json",
		"auth_index":"oauth-1",
		"provider":"codex",
		"email":"user@example.com",
		"success":"12",
		"failed":2,
		"runtime_only":true
	}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].ID != "oauth-1" || accounts[0].Success != 12 ||
		accounts[0].Failed != 2 || accounts[0].Source != "oauth" || !accounts[0].CanToggle {
		t.Fatalf("accounts = %+v", accounts)
	}
}

func TestParseConfigAccountName(t *testing.T) {
	path, index, ok := parseConfigAccountName("config:openai-compatibility:3")
	if !ok || path != "openai-compatibility" || index != 3 {
		t.Fatalf("parsed = %q %d %t", path, index, ok)
	}
	if _, _, ok := parseConfigAccountName("config:unknown:0"); ok {
		t.Fatal("unknown config path accepted")
	}
}

func containsSecret(value string, secrets ...string) bool {
	for _, secret := range secrets {
		for index := 0; index+len(secret) <= len(value); index++ {
			if value[index:index+len(secret)] == secret {
				return true
			}
		}
	}
	return false
}
