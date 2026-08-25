package rai

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCodexPrepareUsesConfigOverridesAndAuthCommand(t *testing.T) {
	command, err := CodexAdapter{}.Prepare(LaunchContext{
		Profile:    Profile{Name: "work", ReasoningEffort: "xhigh"},
		APIBase:    "https://relay.example",
		APIKey:     "relay_secret",
		Model:      "gpt-test",
		Args:       []string{"exec", "hello"},
		Environ:    []string{"PATH=/bin"},
		RAI:        "/opt/rai",
		Executable: "/usr/bin/codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != "/usr/bin/codex" {
		t.Fatalf("path = %q", command.Path)
	}
	joined := strings.Join(command.Args, " ")
	for _, want := range []string{
		"-c model_provider=relayapi",
		`-c model="gpt-test"`,
		"-c model_reasoning_effort=xhigh",
		`-c model_providers.relayapi.base_url="https://relay.example/v1"`,
		"-c model_providers.relayapi.wire_api=responses",
		`-c model_providers.relayapi.auth.command="/opt/rai"`,
		"exec hello",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args %q missing %q", joined, want)
		}
	}
	if !containsEnv(command.Env, envAPIKey+"=relay_secret") {
		t.Fatalf("env = %v", command.Env)
	}
}

func TestOpenCodePrepareUsesRuntimeConfigContent(t *testing.T) {
	command, err := OpenCodeAdapter{}.Prepare(LaunchContext{
		Profile:    Profile{Name: "work", OpenCodeProtocol: "responses"},
		APIBase:    "https://relay.example/",
		APIKey:     "relay_secret",
		Model:      "gpt-test",
		Models:     []string{"gpt-test", "other"},
		Args:       []string{"run", "task"},
		Environ:    []string{"HOME=/tmp"},
		Executable: "/usr/bin/opencode",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(command.Args, " "); got != "run task" {
		t.Fatalf("args = %q", got)
	}
	content := envValue(command.Env, "OPENCODE_CONFIG_CONTENT")
	var document map[string]any
	if err := json.Unmarshal([]byte(content), &document); err != nil {
		t.Fatal(err)
	}
	if document["model"] != "relayapi/gpt-test" {
		t.Fatalf("model = %#v", document["model"])
	}
	provider := document["provider"].(map[string]any)["relayapi"].(map[string]any)
	if provider["npm"] != "@ai-sdk/openai" {
		t.Fatalf("npm = %#v", provider["npm"])
	}
	options := provider["options"].(map[string]any)
	if options["baseURL"] != "https://relay.example/v1" || options["apiKey"] != "{env:RAI_API_KEY}" {
		t.Fatalf("options = %#v", options)
	}
}

func TestResolveLaunchModelValidatesAllowlist(t *testing.T) {
	got, err := resolveLaunchModel(Profile{DefaultModel: "keep"}, "", []string{"keep", "other"})
	if err != nil || got != "keep" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := resolveLaunchModel(Profile{}, "missing", []string{"keep"}); err == nil {
		t.Fatal("expected missing model error")
	}
}

func TestLookPathUsesFakeBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a unix stub")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho codex 1.0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	got, version, err := CodexAdapter{}.Probe()
	if err != nil {
		t.Fatal(err)
	}
	if got != path {
		t.Fatalf("path = %q", got)
	}
	if !strings.Contains(version, "codex") {
		t.Fatalf("version = %q", version)
	}
}

func containsEnv(env []string, wanted string) bool {
	for _, item := range env {
		if item == wanted {
			return true
		}
	}
	return false
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}
