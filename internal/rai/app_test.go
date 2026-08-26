package rai

import (
	"bytes"
	"context"
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

func TestLoginStatusModelsAndLaunch(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"name":"RelayAPI","kind":"rai.dev/v1","adapters":["codex","opencode"],"contract_version":"1"}`)
	})
	mux.HandleFunc("GET /api/rai/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer relay_login" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"name":"RelayAPI","models":["gpt-test","other"],"default_model":"gpt-test","adapters":["codex"]}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	if runtime.GOOS == "windows" {
		t.Skip("uses a unix stub")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	home := t.TempDir()
	var launched Command
	app := App{
		Home:    home,
		Stdin:   strings.NewReader("relay_login\n"),
		Stdout:  &bytes.Buffer{},
		Stderr:  &bytes.Buffer{},
		Environ: []string{"PATH=/bin"},
		Gateway: Gateway{HTTP: server.Client()},
		Now:     func() time.Time { return time.Date(2026, 8, 25, 8, 0, 0, 0, time.UTC) },
		Self:    "/opt/rai",
		Run: func(_ context.Context, command Command, _ io.Reader, _, _ io.Writer) error {
			launched = command
			return nil
		},
	}

	app.Args = []string{"login", "--server", server.URL, "--api-key-stdin", "--profile", "work"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}

	app.Stdin = strings.NewReader("")
	app.Stdout = &bytes.Buffer{}
	app.Args = []string{"--profile", "work", "status"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(app.Stdout.(*bytes.Buffer).String(), "gpt-test") {
		t.Fatalf("status = %s", app.Stdout)
	}

	app.Stdout = &bytes.Buffer{}
	app.Args = []string{"--profile", "work", "models"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(app.Stdout.(*bytes.Buffer).String(), "* gpt-test") {
		t.Fatalf("models = %s", app.Stdout)
	}

	app.Stdout = &bytes.Buffer{}
	app.Args = []string{"--profile", "work", "credential", "print"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(app.Stdout.(*bytes.Buffer).String()) != "relay_login" {
		t.Fatalf("credential print = %q", app.Stdout)
	}

	app.Args = []string{"codex", "--profile", "work", "--model", "other", "--", "exec", "hello"}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(launched.Args, " "), `model="other"`) {
		t.Fatalf("launch args = %v", launched.Args)
	}
	if launched.Args[len(launched.Args)-2] != "exec" || launched.Args[len(launched.Args)-1] != "hello" {
		t.Fatalf("passthrough = %v", launched.Args)
	}
	if _, err := osStatConfig(home); err != nil {
		t.Fatal(err)
	}
}

func TestDoctorReportsMissingAgent(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	t.Setenv("PATH", t.TempDir())
	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutCredential("default", "relay_x"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "default", ServerURL: "https://relay.example", DefaultModel: "m"}); err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	app := App{
		Args:    []string{"doctor"},
		Home:    home,
		Stdout:  stdout,
		Stderr:  &bytes.Buffer{},
		Gateway: Gateway{HTTP: http.DefaultClient},
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "codex") || !strings.Contains(stdout.String(), "not on PATH") {
		t.Fatalf("doctor = %s", stdout.String())
	}
}

func TestSplitLaunchArgsKeepsAgentFlags(t *testing.T) {
	model, rest, err := splitLaunchArgs([]string{"--model", "gpt", "--full-auto", "--", "review"})
	if err != nil || model != "gpt" {
		t.Fatalf("model = %q err=%v", model, err)
	}
	if strings.Join(rest, " ") != "--full-auto review" {
		t.Fatalf("rest = %#v", rest)
	}
}

func osStatConfig(home string) (any, error) {
	return filepath.Abs(filepath.Join(home, "config.json"))
}
