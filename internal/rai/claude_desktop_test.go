package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func desktopTestContext(t *testing.T) LaunchContext {
	t.Helper()
	ctx := configureTestContext(t)
	ctx.RAI = filepath.Join(t.TempDir(), "rai executable")
	ctx.APIBase, ctx.APIKey = "https://relay.example/api", "must-not-be-saved"
	ctx.Model = "claude-sonnet-5-5"
	ctx.Models = []string{"gpt-main", ctx.Model, "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-99-0"}
	ctx.ModelInfo["claude-opus-99-0"] = ModelInfo{ToolCall: boolValue(false)}
	return ctx
}

func TestClaudeDesktopPaths(t *testing.T) {
	home := t.TempDir()
	for platform, want := range map[string]string{
		"linux":   filepath.Join(home, "xdg", "Claude-3p"),
		"darwin":  filepath.Join(home, "Library", "Application Support", "Claude-3p"),
		"windows": filepath.Join(home, "local", "Claude-3p"),
	} {
		env := []string{"HOME=" + home, "XDG_CONFIG_HOME=" + filepath.Join(home, "xdg"), "LOCALAPPDATA=" + filepath.Join(home, "local")}
		got, err := claudeDesktopHome(env, platform)
		if err != nil || got != want {
			t.Fatalf("%s path %s, %v; want %s", platform, got, err, want)
		}
		explicit := filepath.Join(home, "custom")
		got, err = claudeDesktopHome(append(env, "CLAUDE_USER_DATA_DIR="+explicit), platform)
		if err != nil || got != explicit {
			t.Fatalf("explicit path: %s, %v", got, err)
		}
	}
}

func TestClaudeDesktopUsesBoundHelperAndNativeModelFamilies(t *testing.T) {
	ctx := desktopTestContext(t)
	files, err := loadAgentConfig("claude-desktop", ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	files[0].Document["inferenceGatewayApiKey"] = "old-secret"
	files[1].Document = map[string]any{"appliedId": "other-id", "entries": []any{map[string]any{"id": "other-id", "name": "My gateway"}}, "hybridPointer": map[string]any{"bootstrapUrl": "https://old.example"}}
	files[2].Document["preferences"] = map[string]any{"theme": "dark"}
	if err := buildAgentConfig("claude-desktop", ctx, files); err != nil {
		t.Fatal(err)
	}
	doc := files[0].Document
	if doc["inferenceGatewayBaseUrl"] != ctx.APIBase || doc["inferenceCredentialHelper"] != ctx.RAI || doc["inferenceCredentialKind"] != "helper-script" {
		t.Fatalf("invalid gateway config: %#v", doc)
	}
	wantArgs := []string{"--profile", "work", "credential", "print", "--home", ctx.RAIHome, "--server", ctx.Profile.ServerURL}
	if !reflect.DeepEqual(doc["inferenceCredentialHelperArgs"], wantArgs) {
		t.Fatal("credential helper lost home/profile/audience binding")
	}
	models := doc["inferenceModels"].([]any)
	if len(models) != 3 || models[0].(map[string]any)["name"] != ctx.Model {
		t.Fatalf("wrong model list: %#v", models)
	}
	for _, raw := range models {
		entry := raw.(map[string]any)
		if entry["isFamilyDefault"] != true {
			t.Fatalf("missing family default: %#v", entry)
		}
	}
	if _, exists := doc["inferenceGatewayApiKey"]; exists {
		t.Fatal("old static credential remains")
	}
	if files[1].Document["hybridPointer"] != nil || files[1].Document["appliedId"] != claudeDesktopProfileID {
		t.Fatal("profile was not selected")
	}
	if len(files[1].Document["entries"].([]any)) != 2 {
		t.Fatal("other Desktop profile lost")
	}
	if files[2].Document["deploymentMode"] != "3p" || files[2].Document["preferences"] == nil {
		t.Fatal("Desktop preferences lost")
	}
	for _, f := range files {
		raw, err := f.render(f.Document)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(raw, []byte(ctx.APIKey)) || bytes.Contains(raw, []byte("old-secret")) {
			t.Fatal("credential leaked in Desktop config")
		}
	}
	ctx.Model = "gpt-main"
	if err := buildAgentConfig("claude-desktop", ctx, files); err == nil {
		t.Fatal("Desktop accepted non-Claude model")
	}
}

func TestClaudeDesktopRestorePreservesNewProfilesAndSelection(t *testing.T) {
	for _, changedSelection := range []bool{false, true} {
		t.Run(map[bool]string{false: "original-selection", true: "user-selection"}[changedSelection], func(t *testing.T) {
			ctx := desktopTestContext(t)
			files, err := loadAgentConfig("claude-desktop", ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			oldMeta := `{"appliedId":"original","entries":[{"id":"original","name":"Original"}],"hybridPointer":{"bootstrapUrl":"https://old.example"}}`
			if err := writeFileAtomic(files[1].Path, []byte(oldMeta), 0600); err != nil {
				t.Fatal(err)
			}
			files, _ = loadAgentConfig("claude-desktop", ctx.Environ)
			for range 2 {
				if err := buildAgentConfig("claude-desktop", ctx, files); err != nil {
					t.Fatal(err)
				}
				if err := saveClientConfig("claude-desktop", "work", files); err != nil {
					t.Fatal(err)
				}
				files, err = loadAgentConfig("claude-desktop", ctx.Environ)
				if err != nil {
					t.Fatal(err)
				}
			}
			meta := files[1]
			entries := meta.Document["entries"].([]any)
			meta.Document["entries"] = append(entries, map[string]any{"id": "new-user-profile", "name": "New"})
			if changedSelection {
				meta.Document["appliedId"] = "new-user-profile"
			}
			raw, _ := meta.render(meta.Document)
			if err := writeFileAtomic(meta.Path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			files, err = loadAgentConfig("claude-desktop", ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if ok, err := restoreAgentConfig("claude-desktop", "work", files); !ok || err != nil {
				t.Fatalf("restore %v", err)
			}
			read, err := readClientConfig(meta.Path, "json")
			if err != nil {
				t.Fatal(err)
			}
			if len(read.Document["entries"].([]any)) != 2 {
				t.Fatalf("wrong restored library: %#v", read.Document)
			}
			want := "original"
			if changedSelection {
				want = "new-user-profile"
			}
			if read.Document["appliedId"] != want {
				t.Fatal("user selection lost")
			}
			if changedSelection && read.Document["hybridPointer"] != nil {
				t.Fatal("old hybrid profile overrides new user selection")
			}
			for _, index := range []int{0, 2} {
				if _, err := os.Stat(files[index].Path); !os.IsNotExist(err) {
					t.Fatal("new Desktop file was not removed")
				}
			}
		})
	}
}

func TestClaudeDesktopConfigureCommandDoesNotStartProxyOrSaveTokens(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/session" {
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, `{"models":["gpt-main","claude-sonnet-5-5","claude-opus-5-5","claude-haiku-5-5"],"default_model":"gpt-main"}`)
	}))
	defer server.Close()
	ctx := desktopTestContext(t)
	var output bytes.Buffer
	a := &App{Home: ctx.RAIHome, Self: ctx.RAI, Environ: ctx.Environ, Stdout: &output, Stderr: &output, Args: []string{"configure", "claude-desktop", "--yes"}}
	a.defaults()
	store, profile := saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(time.Hour))
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := readProxyState(store, profile); !os.IsNotExist(err) {
		t.Fatalf("Desktop started a background proxy: %v", err)
	}
	files, err := loadAgentConfig("claude-desktop", a.Environ)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.Contains(string(f.Raw), "rai_at_initial") || strings.Contains(string(f.Raw), "rai_rt_initial") {
			t.Fatal("OAuth tokens persisted in Desktop config")
		}
	}
	// Exercise the exact generated helper arguments, including server binding.
	values := files[0].Document["inferenceCredentialHelperArgs"].([]any)
	args := make([]string, len(values))
	for i, v := range values {
		args[i] = v.(string)
	}
	output.Reset()
	a.Args = args
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if output.String() != "rai_at_initial\n" {
		t.Fatal("helper did not print only an access token")
	}
	a.Args = []string{"unconfigure", "claude-desktop"}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if _, err := os.Stat(f.Path); !os.IsNotExist(err) {
			t.Fatal("unconfigure left generated files")
		}
	}
}

func TestClaudeDesktopRejectsBrokenLibraryBeforeLogin(t *testing.T) {
	for _, invalid := range []string{`{"entries":{}}`, `{"entries":[{"id":"dup","name":"a"},{"id":"dup","name":"b"}]}`, `{"appliedId":"missing","entries":[]}`} {
		ctx := desktopTestContext(t)
		targets, _ := claudeDesktopConfigTargets(ctx.Environ)
		if err := writeFileAtomic(targets[1].Path, []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		a := &App{Home: ctx.RAIHome, Environ: ctx.Environ, Args: []string{"configure", "claude-desktop", "--yes"}, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
		if err := a.Execute(context.Background()); err == nil {
			t.Fatal("broken library accepted")
		}
		raw, _ := os.ReadFile(targets[1].Path)
		if string(raw) != invalid {
			t.Fatal("broken library was changed")
		}
	}
}

func TestClaudeDesktopMultiFileFailureRollsBack(t *testing.T) {
	ctx := desktopTestContext(t)
	targets, _ := claudeDesktopConfigTargets(ctx.Environ)
	if err := writeFileAtomic(targets[2].Path, []byte(`{"preferences":{"theme":"dark"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	files, err := loadAgentConfig("claude-desktop", ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	if err := buildAgentConfig("claude-desktop", ctx, files); err != nil {
		t.Fatal(err)
	}
	// The last file's backup fails after the first two files were replaced.
	if err := os.Mkdir(files[2].Path+".rai.bak", 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("claude-desktop", "work", files); err == nil {
		t.Fatal("injected write failure did not fail")
	}
	for _, file := range files[:2] {
		if _, err := os.Stat(file.Path); !os.IsNotExist(err) {
			t.Fatal("partially selected Desktop profile remained")
		}
		if _, err := os.Stat(clientConfigJournalPath(file.Path, "claude-desktop")); !os.IsNotExist(err) {
			t.Fatal("partial Desktop recovery record remained")
		}
	}
	raw, _ := os.ReadFile(files[2].Path)
	if !bytes.Equal(raw, files[2].Raw) {
		t.Fatal("original Desktop preferences changed after failed transaction")
	}
}

// Keep JSON decoding exercised explicitly: Desktop consumes ordinary strict
// JSON even though rai's general client editor can preserve JSONC comments.
func TestClaudeDesktopGeneratedFilesAreStrictJSON(t *testing.T) {
	ctx := desktopTestContext(t)
	files, _ := loadAgentConfig("claude-desktop", ctx.Environ)
	if err := buildAgentConfig("claude-desktop", ctx, files); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("claude-desktop", "work", files); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file.Path)
		if !json.Valid(raw) {
			t.Fatal("invalid Desktop JSON")
		}
	}
}

func TestClaudeDesktopRestoreDoesNotReattachOldAuthToEditedGateway(t *testing.T) {
	ctx := desktopTestContext(t)
	files, _ := loadAgentConfig("claude-desktop", ctx.Environ)
	old := []byte(`{"inferenceProvider":"gateway","inferenceGatewayBaseUrl":"https://old.example","inferenceGatewayApiKey":"old-key","inferenceCredentialKind":"static"}`)
	if err := writeFileAtomic(files[0].Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	files, _ = loadAgentConfig("claude-desktop", ctx.Environ)
	if err := buildAgentConfig("claude-desktop", ctx, files); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("claude-desktop", "work", files); err != nil {
		t.Fatal(err)
	}
	files, _ = loadAgentConfig("claude-desktop", ctx.Environ)
	files[0].Document["inferenceGatewayBaseUrl"] = "https://user-edited.example"
	raw, _ := files[0].render(files[0].Document)
	if err := writeFileAtomic(files[0].Path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	files, _ = loadAgentConfig("claude-desktop", ctx.Environ)
	if _, err := restoreAgentConfig("claude-desktop", "work", files); err != nil {
		t.Fatal(err)
	}
	read, err := readClientConfig(files[0].Path, "json")
	if err != nil {
		t.Fatal(err)
	}
	if read.Document["inferenceGatewayBaseUrl"] != "https://user-edited.example" || read.Document["inferenceGatewayApiKey"] != nil || read.Document["inferenceCredentialKind"] != "helper-script" {
		t.Fatal("restoration mixed credentials with an edited destination")
	}
}

func TestClaudeDesktopRestoreWhenUserRemovedPreviousProfile(t *testing.T) {
	current := map[string]any{"appliedId": claudeDesktopProfileID, "entries": []any{map[string]any{"id": claudeDesktopProfileID, "name": "RelayAPI"}, map[string]any{"id": "new", "name": "User"}}}
	before := map[string]any{"appliedId": "removed", "entries": []any{map[string]any{"id": "removed", "name": "Old"}}}
	after := map[string]any{"appliedId": claudeDesktopProfileID, "entries": []any{map[string]any{"id": "removed", "name": "Old"}, map[string]any{"id": claudeDesktopProfileID, "name": "RelayAPI"}}}
	restoreConfiguredClient("claude-desktop", current, before, after)
	if current["appliedId"] != "new" || len(current["entries"].([]any)) != 1 {
		t.Fatal("restored a pointer to a removed Desktop profile")
	}
}
