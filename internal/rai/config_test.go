package rai

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProfileRoundTripAndActiveSelection(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profile := Profile{
		Name: "work", ServerURL: "https://relay.example",
		DefaultModel: "gpt-test", ReasoningEffort: "high", OpenCodeProtocol: "responses",
	}
	if err := store.PutProfile(profile); err != nil {
		t.Fatal(err)
	}
	if err := store.SetActive("work"); err != nil {
		t.Fatal(err)
	}
	got, err := store.ResolveProfile("")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "work" || got.ServerURL != "https://relay.example" {
		t.Fatalf("profile = %#v", got)
	}
	info, err := os.Stat(store.configPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %o", info.Mode().Perm())
	}
}

func TestResolveProfilePrefersFlagThenEnv(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "one", ServerURL: "https://one.example"}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "two", ServerURL: "https://two.example"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetActive("one"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envProfile, "two")
	got, err := store.ResolveProfile("")
	if err != nil || got.Name != "two" {
		t.Fatalf("env profile = %#v, err=%v", got, err)
	}
	got, err = store.ResolveProfile("one")
	if err != nil || got.Name != "one" {
		t.Fatalf("flag profile = %#v, err=%v", got, err)
	}
}

func TestWriteFileAtomicUsesSameDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.json")
	if err := writeFileAtomic(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "{}\n" {
		t.Fatalf("content = %q, err=%v", raw, err)
	}
}

func TestNormalizeServerURL(t *testing.T) {
	got, err := normalizeServerURL(" https://relay.example/ ")
	if err != nil || got != "https://relay.example" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := normalizeServerURL("relay.example"); err == nil {
		t.Fatal("expected scheme error")
	}
}
