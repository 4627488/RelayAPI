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

func desktopTestApp(t *testing.T) (*App, Store, string) {
	t.Helper()
	t.Setenv(envDisableKey, "1")
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutProfile(Profile{Name: "work", ServerURL: "https://relay.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutCredential("work", "first-secret"); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	a := &App{Home: s.Home, Environ: []string{"CODEX_HOME=" + home}, Stdin: strings.NewReader(""), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	return a, s, filepath.Join(home, "config.toml")
}

func runDesktopTest(t *testing.T, a *App, args ...string) error {
	t.Helper()
	a.Args = append([]string{"--profile", "work"}, args...)
	return a.Execute(context.Background())
}

func TestCodexHelperTracksCredentialsAndBindsStoreAndServer(t *testing.T) {
	a, s, _ := desktopTestApp(t)
	a.Home = t.TempDir() // Desktop's environment must not select another store.
	auth, err := codexAuth(Profile{Name: "work", ServerURL: "https://relay.example"}, s.Home, "")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(auth["command"].(string)) {
		t.Fatal("helper is not absolute")
	}
	args := auth["args"].([]string)
	for _, secret := range []string{"first-secret", "rotated-secret"} {
		if _, err := s.PutCredential("work", secret); err != nil {
			t.Fatal(err)
		}
		a.Stdout = &bytes.Buffer{}
		a.Args = args
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		if a.Stdout.(*bytes.Buffer).String() != secret+"\n" {
			t.Fatal("helper did not read current key")
		}
	}
	if err := s.PutProfile(Profile{Name: "work", ServerURL: "https://other.example"}); err != nil {
		t.Fatal(err)
	}
	a.Stdout = &bytes.Buffer{}
	if err := a.Execute(context.Background()); err == nil || a.Stdout.(*bytes.Buffer).Len() != 0 {
		t.Fatal("audience change exposed credential")
	}
	if err := s.PutProfile(Profile{Name: "work", ServerURL: "https://relay.example"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteCredential("work"); err != nil {
		t.Fatal(err)
	}
	if err := a.Execute(context.Background()); err == nil || a.Stdout.(*bytes.Buffer).Len() != 0 {
		t.Fatal("deleted credential still usable")
	}
}

func TestCodexTemporaryRecoveryOverPermanent(t *testing.T) {
	for _, input := range []string{"ready\nrestore\n", "ready\n"} {
		t.Run(strings.TrimSpace(input), func(t *testing.T) {
			a, _, path := desktopTestApp(t)
			original := []byte("# original\nmodel_provider = 'openai'\n[mcp_servers.docs]\ncommand = 'docs'\n")
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := runDesktopTest(t, a, "configure", "codex", "-y"); err != nil {
					t.Fatal(err)
				}
			}
			permanent, _ := os.ReadFile(path)
			a.Stdin = strings.NewReader(input)
			err := runDesktopTest(t, a, "codex", "--desktop")
			if input == "ready\n" {
				if err == nil {
					t.Fatal("EOF must leave recovery instructions")
				}
				if err := runDesktopTest(t, a, "configure", "codex", "-y"); err == nil {
					t.Fatal("overwrote pending temporary switch")
				}
				if err := runDesktopTest(t, a, "unconfigure", "codex"); err != nil {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(path)
			if !bytes.Equal(got, permanent) {
				t.Fatal("did not restore permanent configuration")
			}
			if err := runDesktopTest(t, a, "unconfigure", "codex"); err != nil {
				t.Fatal(err)
			}
			got, _ = os.ReadFile(path)
			if !bytes.Equal(got, original) {
				t.Fatalf("original formatting lost: %s", got)
			}
		})
	}
}

func TestCodexTemporaryCancel(t *testing.T) {
	a, _, path := desktopTestApp(t)
	a.Stdin = strings.NewReader("no\n")
	if err := runDesktopTest(t, a, "codex", "--desktop"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cancel wrote configuration")
	}
}

func TestCodexRestorePreservesUserEditsAndAtomicAuth(t *testing.T) {
	for _, edit := range []string{"unrelated", "helper", "url", "delete"} {
		t.Run(edit, func(t *testing.T) {
			a, _, path := desktopTestApp(t)
			original := []byte("model_provider = 'openai'\n[model_providers.relayapi]\nbase_url = 'https://old.example/v1'\nenv_key = 'OLD_KEY'\n[model_providers.relayapi.http_headers]\nAuthorization = 'Bearer old'\nX-Keep = 'old'\n")
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			if err := runDesktopTest(t, a, "configure", "codex", "-y"); err != nil {
				t.Fatal(err)
			}
			_, doc, _ := loadCodexConfig(path)
			providers := doc["model_providers"].(map[string]any)
			provider := providers[providerID].(map[string]any)
			doc["user_setting"] = "keep"
			provider["http_headers"].(map[string]any)["X-Keep"] = "new"
			switch edit {
			case "helper":
				provider["auth"].(map[string]any)["args"] = []string{"user-args"}
			case "url":
				provider["base_url"] = "https://new.example/v1"
			case "delete":
				delete(providers, providerID)
			}
			group := codexAuthGroup(provider)
			raw, _ := toml.Marshal(doc)
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := runDesktopTest(t, a, "unconfigure", "codex"); err != nil {
				t.Fatal(err)
			}
			_, doc, _ = loadCodexConfig(path)
			if doc["user_setting"] != "keep" || doc["model_provider"] != "openai" {
				t.Fatal("incorrect field restoration")
			}
			providers = doc["model_providers"].(map[string]any)
			if edit == "delete" {
				if _, ok := providers[providerID]; ok {
					t.Fatal("resurrected deleted provider")
				}
				return
			}
			provider = providers[providerID].(map[string]any)
			if provider["http_headers"].(map[string]any)["X-Keep"] != "new" {
				t.Fatal("lost user header")
			}
			if edit == "unrelated" {
				if provider["env_key"] != "OLD_KEY" || provider["auth"] != nil {
					t.Fatal("did not restore old auth")
				}
			} else {
				// Normalize []string versus TOML's []any before comparing.
				want, _ := toml.Marshal(group)
				got, _ := toml.Marshal(codexAuthGroup(provider))
				if !reflect.DeepEqual(want, got) {
					t.Fatalf("mixed authentication: %s", got)
				}
			}
		})
	}
}

func TestCodexCorruptRecoveryDoesNotChangeConfig(t *testing.T) {
	a, _, path := desktopTestApp(t)
	if err := runDesktopTest(t, a, "configure", "codex", "-y"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	if err := os.WriteFile(codexJournalPath(path, false), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runDesktopTest(t, a, "unconfigure", "codex"); err == nil {
		t.Fatal("accepted corrupt recovery record")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("changed config with corrupt record")
	}
}
