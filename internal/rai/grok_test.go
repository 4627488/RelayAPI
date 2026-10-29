package rai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGrokLaunchRegistersModelWithoutSavingSecretOrChangingDefault(t *testing.T) {
	ctx := configureTestContext(t)
	ctx.Executable = "/fake/grok"
	ctx.APIKey = "relay_private_test_key"
	ctx.Args = []string{"--model=" + ctx.Model, "-p", "--model=" + ctx.Model}
	files := seedAgentConfig(t, "grok", ctx)
	original := append([]byte(nil), files[0].Raw...)
	command, err := (GrokAdapter{}).Prepare(ctx)
	if err != nil {
		t.Fatal(err)
	}
	configured, err := readClientConfig(files[0].Path, "toml")
	if err != nil {
		t.Fatal(err)
	}
	if configured.Document["models"].(map[string]any)["default"] != "before" {
		t.Fatal("launch changed persisted default")
	}
	alias := grokModelAlias(launchProviderID(ctx)+"_launch", ctx.Model)
	entry := configured.Document["model"].(map[string]any)[alias].(map[string]any)
	if entry["model"] != ctx.Model || entry["env_key"] != envAPIKey {
		t.Fatal("launch model is not bound to runtime credential")
	}
	if strings.Contains(string(configured.Raw), ctx.APIKey) {
		t.Fatal("static credential written into Grok configuration")
	}
	if command.Args[0] != "--model="+alias || command.Args[2] != "--model="+ctx.Model {
		t.Fatal("native model flag or literal prompt was rewritten incorrectly")
	}
	if ok, err := restoreAgentConfig("grok", "work", []*clientConfigFile{configured}); !ok || err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(filepath.Clean(files[0].Path))
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatal("launch model registration could not be restored")
	}
}

func TestGrokLaunchPreservesConfiguredCredential(t *testing.T) {
	ctx := configureTestContext(t)
	files := seedAgentConfig(t, "grok", ctx)
	if err := buildAgentConfig("grok", ctx, files); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("grok", "work", files); err != nil {
		t.Fatal(err)
	}
	ctx.Executable = "/fake/grok"
	ctx.APIKey = "rai_local_launch_only"
	if _, err := (GrokAdapter{}).Prepare(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := readClientConfig(files[0].Path, "toml")
	if err != nil {
		t.Fatal(err)
	}
	alias := grokModelAlias(launchProviderID(ctx), ctx.Model)
	entry := current.Document["model"].(map[string]any)[alias].(map[string]any)
	if entry["api_key"] != "rai_local_test" {
		t.Fatal("launch overwrote persistent configure credential")
	}
}
