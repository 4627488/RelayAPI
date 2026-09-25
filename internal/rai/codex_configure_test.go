package rai

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestConfigureCodexConfirmationAndMerge(t *testing.T) {
	for _, tc := range []struct {
		name, input, flag string
		write, wantError  bool
	}{
		{name: "decline", input: "n\n"},
		{name: "empty", input: "\n"},
		{name: "EOF", wantError: true},
		{name: "confirm", input: "YES\n", write: true},
		{name: "short flag", flag: "-y", write: true},
		{name: "long flag", flag: "--yes", write: true},
		{name: "invalid flag", flag: "--force", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(envDisableKey, "1")
			store, err := OpenStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			profile := Profile{Name: "work", ServerURL: "https://relay.example"}
			if err := store.PutProfile(profile); err != nil {
				t.Fatal(err)
			}
			secret := "relay_test-\"\\secret"
			if _, err := store.PutCredential(profile.Name, secret); err != nil {
				t.Fatal(err)
			}
			home := t.TempDir()
			path := filepath.Join(home, "config.toml")
			original := []byte(`# Keep my settings
model = "saved-model"
model_reasoning_effort = "high"
model_provider = "other"
[mcp_servers.docs]
command = "docs-server"
args = ["one", "two"]
[projects."C:\\work"]
trust_level = "trusted"
[model_providers.other]
name = "Other"
env_key = "OTHER_KEY"
[model_providers.relayapi]
request_max_retries = 7
env_key = "OLD_KEY"
requires_openai_auth = true
experimental_bearer_token = "old-token"
[model_providers.relayapi.auth]
command = "old-helper"
[model_providers.relayapi.http_headers]
Authorization = "Bearer old"
"X-Custom" = "keep"
`)
			if err := os.WriteFile(path, original, 0o600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			app := App{Home: store.Home, Args: []string{"--profile", "work", "configure", "codex"},
				Environ: []string{"CODEX_HOME=" + home}, Stdin: strings.NewReader(tc.input), Stdout: &output, Stderr: &output}
			if tc.flag != "" {
				app.Args = append(app.Args, tc.flag)
			}
			err = app.Execute(context.Background())
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v", err)
			}
			if strings.Contains(output.String(), secret) {
				t.Fatal("credential leaked to output")
			}
			raw, document, err := loadCodexConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.write {
				if !bytes.Equal(raw, original) {
					t.Fatal("changed without confirmation")
				}
				if _, err := os.Stat(path + ".rai.bak"); !os.IsNotExist(err) {
					t.Fatal("backup created without confirmation")
				}
				return
			}
			backup, err := os.ReadFile(path + ".rai.bak")
			if err != nil || !bytes.Equal(backup, original) {
				t.Fatal("original backup not preserved")
			}
			var before map[string]any
			if err := toml.Unmarshal(original, &before); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"model", "model_reasoning_effort", "mcp_servers", "projects"} {
				if !reflect.DeepEqual(document[name], before[name]) {
					t.Fatalf("lost %s", name)
				}
			}
			providers := document["model_providers"].(map[string]any)
			if !reflect.DeepEqual(providers["other"], before["model_providers"].(map[string]any)["other"]) {
				t.Fatal("changed another provider")
			}
			provider := providers[providerID].(map[string]any)
			if document["model_provider"] != providerID || provider["experimental_bearer_token"] != secret || provider["base_url"] != "https://relay.example/v1" || provider["request_max_retries"] != int64(7) {
				t.Fatal("incorrect merged provider")
			}
			for _, name := range []string{"auth", "env_key", "requires_openai_auth"} {
				if _, exists := provider[name]; exists {
					t.Fatalf("conflicting %s retained", name)
				}
			}
			headers := provider["http_headers"].(map[string]any)
			if len(headers) != 1 || headers["X-Custom"] != "keep" {
				t.Fatal("incorrect header merge")
			}
		})
	}
}

func TestCodexRuntimeAvoidsPersistedCredentials(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")
	original := []byte(`[model_providers.relayapi]
experimental_bearer_token = "old-token"
[model_providers.relayapi_rai]
env_key = "OLD_KEY"
[model_providers.relayapi_rai_2]
requires_openai_auth = true
`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	command, err := (CodexAdapter{}).Prepare(LaunchContext{Profile: Profile{Name: "work"},
		APIBase: "https://relay.example", APIKey: "new-token", Executable: "codex", RAI: "rai",
		Environ: []string{"CODEX_HOME=" + home}})
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(command.Args, " ")
	if !strings.Contains(args, "model_provider=relayapi_rai_3") || !strings.Contains(args, "model_providers.relayapi_rai_3.auth.command=") {
		t.Fatal("did not isolate runtime provider")
	}
	if strings.Contains(args, "new-token") || strings.Contains(args, "old-token") {
		t.Fatal("key exposed in process arguments")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("launch changed saved config")
	}
}

func TestCodexConfigRejectsInvalidTOMLWithoutLeakingSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(`experimental_bearer_token = "secret`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := loadCodexConfig(path)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe parse error: %v", err)
	}
}

func TestMergeCodexConfigNewFileAndIdempotence(t *testing.T) {
	profile := Profile{Name: "work", ServerURL: "https://relay.example/", DefaultModel: "coding", ReasoningEffort: "xhigh"}
	raw, err := mergeCodexConfig(map[string]any{}, profile, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := toml.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if document["model"] != "coding" || document["model_reasoning_effort"] != "xhigh" {
		t.Fatal("missing model preferences")
	}
	again, err := mergeCodexConfig(document, profile, "test-token")
	if err != nil || !bytes.Equal(raw, again) {
		t.Fatal("merge is not idempotent")
	}
}
