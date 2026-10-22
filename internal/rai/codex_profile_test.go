package rai

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeCodexProfilePreservesRootAndRestoresEdits(t *testing.T) {
	a, _, root := desktopTestApp(t)
	original := []byte("# Preserve root formatting\nmodel='root'\n[model_providers.relayapi_rai]\nenv_key='OTHER_KEY'\n")
	if err := os.WriteFile(root, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := runDesktopTest(t, a, "configure", "codex", "--codex-profile", "relay", "--yes"); err != nil {
		t.Fatal(err)
	}
	rootAfter, _ := os.ReadFile(root)
	if !bytes.Equal(original, rootAfter) {
		t.Fatal("native profile rewrote root config")
	}
	path := filepath.Join(filepath.Dir(root), "relay.config.toml")
	_, document, err := loadCodexConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if document["model_provider"] != "relayapi_rai_2" {
		t.Fatal("provider collided with inherited auth")
	}
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte("first-secret")) {
		t.Fatal("wrote token to native profile")
	}
	if err := os.WriteFile(path, append(raw, []byte("\n[notice]\nhide_rate_limit_model_nudge=true\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runDesktopTest(t, a, "unconfigure", "codex", "--codex-profile", "relay"); err != nil {
		t.Fatal(err)
	}
	_, restored, err := loadCodexConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if restored["notice"] == nil || restored["model_provider"] != nil {
		t.Fatalf("wrong restoration: %v", restored)
	}
	rootAfter, _ = os.ReadFile(root)
	if !bytes.Equal(original, rootAfter) {
		t.Fatal("restore changed root")
	}
}

func TestCodexLaunchAvoidsNativeProfileCredentials(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "work.config.toml"), []byte("[model_providers.relayapi_rai]\nenv_key='OTHER'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd, err := (CodexAdapter{}).Prepare(LaunchContext{Profile: Profile{Name: "test", ServerURL: "https://relay.example"}, APIBase: "https://relay.example", RAIHome: t.TempDir(), Executable: "codex", Args: []string{"--profile", "work"}, Environ: []string{"CODEX_HOME=" + home}, Codex: &CodexCapabilities{Version: 1, WebSockets: true, RemoteCompaction: true}})
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(cmd.Args, " ")
	for _, wanted := range []string{"model_provider=relayapi_rai_2", "supports_websockets=true", "remote_compaction=\"v2\"", "auth.timeout_ms=30000", "auth.refresh_interval_ms=60000"} {
		if !strings.Contains(args, wanted) {
			t.Fatalf("missing %s: %s", wanted, args)
		}
	}
}

func TestCodexMissingCapabilitiesDoNotInventTransport(t *testing.T) {
	for _, capabilities := range []*CodexCapabilities{nil, {Version: 99, WebSockets: true, RemoteCompaction: true}} {
		cmd, err := (CodexAdapter{}).Prepare(LaunchContext{Profile: Profile{Name: "work"}, APIBase: "https://relay.example", Executable: "codex", Environ: []string{"CODEX_HOME=" + t.TempDir()}, Codex: capabilities})
		if err != nil {
			t.Fatal(err)
		}
		args := strings.Join(cmd.Args, " ")
		if !strings.Contains(args, "supports_websockets=false") || strings.Contains(args, "remote_compaction=") {
			t.Fatal(args)
		}
	}
}

func TestReadNativeCodexPreferences(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='root'"), 0600)
	os.WriteFile(filepath.Join(home, "work.config.toml"), []byte("model='coding'\nmodel_reasoning_effort='high'"), 0600)
	preferences, err := readCodexPreferences([]string{"CODEX_HOME=" + home}, "work")
	if err != nil || preferences.Model != "coding" || preferences.Reasoning != "high" {
		t.Fatalf("%+v: %v", preferences, err)
	}
}
