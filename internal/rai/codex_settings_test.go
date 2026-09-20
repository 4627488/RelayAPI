package rai

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCodexRemembersSelectionOnNextLaunch(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	bin := t.TempDir()
	binary := "codex"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if err := os.WriteFile(filepath.Join(bin, binary), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"models":["code-review","coding-model"],"default_model":"code-review"}`)
	}))
	defer server.Close()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "work", ServerURL: server.URL}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutCredential("work", "relay_test"); err != nil {
		t.Fatal(err)
	}
	codexHome := t.TempDir()
	app := App{Home: store.Home, Args: []string{"codex"}, Environ: []string{"CODEX_HOME=" + codexHome}, Stdout: io.Discard, Stderr: io.Discard, Stdin: strings.NewReader(""), Gateway: Gateway{HTTP: server.Client()}}
	app.Run = func(_ context.Context, cmd Command, _ io.Reader, _, _ io.Writer) error {
		args := strings.Join(cmd.Args, " ")
		if strings.Contains(args, "-c model=") || strings.Contains(args, "model_reasoning_effort=") {
			t.Fatalf("overrode native defaults: %s", args)
		}
		// Simulate Codex's persisted /model and reasoning selection.
		return os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model = 'coding-model'\nmodel_reasoning_effort = 'xhigh'\n"), 0o600)
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	profile, err := store.ResolveProfile("work")
	if err != nil || profile.DefaultModel != "coding-model" || profile.ReasoningEffort != "xhigh" {
		t.Fatalf("saved profile = %+v, %v", profile, err)
	}
	app.Run = func(_ context.Context, cmd Command, _ io.Reader, _, _ io.Writer) error {
		args := strings.Join(cmd.Args, " ")
		if !strings.Contains(args, `model="coding-model"`) || !strings.Contains(args, "model_reasoning_effort=xhigh") {
			t.Fatalf("lost saved selection: %s", args)
		}
		return ExitError{Code: 130}
	}
	var exit ExitError
	if err := app.Execute(context.Background()); !errors.As(err, &exit) || exit.Code != 130 {
		t.Fatalf("exit = %v", err)
	}
	app.Args = []string{"use", "--auto"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	app.Args = []string{"codex"}
	app.Run = func(_ context.Context, cmd Command, _ io.Reader, _, _ io.Writer) error {
		if !strings.Contains(strings.Join(cmd.Args, " "), `model="code-review"`) {
			t.Fatalf("site preference not applied: %v", cmd.Args)
		}
		return nil
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	app.Args = []string{"use", "default"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	profile, _ = store.ResolveProfile("work")
	if profile.DefaultModel != "" || profile.ReasoningEffort != "" || profile.FollowSiteDefault {
		t.Fatalf("reset = %+v", profile)
	}
}

func TestCodexSyncOnlyChangedPreferences(t *testing.T) {
	store, _ := OpenStore(t.TempDir())
	initial := Profile{Name: "work", ServerURL: "https://relay.example", DefaultModel: "coding-model", ReasoningEffort: "high"}
	if err := store.PutProfile(initial); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	var stderr bytes.Buffer
	app := App{Environ: []string{"CODEX_HOME=" + home}, Stderr: &stderr}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='other-global-model'\nmodel_reasoning_effort='low'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.saveChangedCodexPreferences(store, "work", codexPreferences{Model: "other-global-model", Reasoning: "high"}, []string{"coding-model"})
	got, _ := store.ResolveProfile("work")
	if got.DefaultModel != initial.DefaultModel || got.ReasoningEffort != "low" {
		t.Fatalf("profile = %+v", got)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='unavailable'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.saveChangedCodexPreferences(store, "work", codexPreferences{}, []string{"coding-model"})
	got, _ = store.ResolveProfile("work")
	if got.DefaultModel != initial.DefaultModel || !strings.Contains(stderr.String(), "not available") {
		t.Fatalf("profile=%+v, warning=%s", got, stderr.String())
	}
}

func TestCodexReselectsPreviouslySavedValues(t *testing.T) {
	store, _ := OpenStore(t.TempDir())
	if err := store.PutProfile(Profile{Name: "work", ServerURL: "https://relay.example", DefaultModel: "code-review", ReasoningEffort: "high"}); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")
	if err := os.WriteFile(path, []byte("model='coding-model'\nmodel_reasoning_effort='xhigh'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := App{Environ: []string{"CODEX_HOME=" + home}, Stderr: io.Discard}
	before, err := readCodexPreferences(app.Environ)
	if err != nil {
		t.Fatal(err)
	}
	// Codex can save the same native values after replacing rai's overrides.
	later := before.modified.Add(time.Second)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	app.saveChangedCodexPreferences(store, "work", before, []string{"coding-model", "code-review"})
	got, _ := store.ResolveProfile("work")
	if got.DefaultModel != "coding-model" || got.ReasoningEffort != "xhigh" {
		t.Fatalf("selection = %+v", got)
	}
}
