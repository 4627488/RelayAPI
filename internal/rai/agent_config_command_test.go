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
	"strings"
	"testing"
	"time"
)

func configureTestContext(t *testing.T) LaunchContext {
	t.Helper()
	home := t.TempDir()
	return LaunchContext{Profile: Profile{Name: "work", ServerURL: "https://relay.example", ReasoningEffort: "high", OpenCodeProtocol: "chat"}, RAIHome: t.TempDir(), Model: "model-a", Models: []string{"model-a", "model-b"}, APIBase: "http://127.0.0.1:12345", APIKey: "rai_local_test", ModelInfo: map[string]ModelInfo{"model-a": {Context: 131072, MaxOutput: 4096, ToolCall: boolValue(true)}, "model-b": {Context: 131072, ToolCall: boolValue(true)}}, Environ: []string{"HOME=" + home, "XDG_CONFIG_HOME=" + filepath.Join(home, "config")}}
}

func seedAgentConfig(t *testing.T, agent string, ctx LaunchContext) []*clientConfigFile {
	t.Helper()
	targets, err := agentConfigTargets(agent, ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	for i, target := range targets {
		var raw string
		switch agent {
		case "claude":
			raw = "{\n// keep my comment\n\"model\":\"before\",\"apiKeyHelper\":\"old-helper\",\"env\":{\"ANTHROPIC_BASE_URL\":\"https://old.example\",\"ANTHROPIC_AUTH_TOKEN\":\"old-private-key\",\"UNRELATED\":\"keep\"},\"permissions\":{\"allow\":[\"Read\"]}}"
		case "opencode":
			raw = `{"model":"other/before","provider":{"other":{"npm":"@ai-sdk/openai","options":{"baseURL":"https://other.example"}}},"permission":{"edit":"ask"}}`
		case "grok":
			raw = "# keep original\n[models]\ndefault='before'\n[model.before]\nmodel='before'\nbase_url='https://other.example'\n[ui]\ntheme='dark'\n"
		case "hermes":
			raw = "# keep original\nmodel:\n  provider: before\n  default: before\n  base_url: https://other.example\n  api_key: old-private-key\ncustom_providers:\n  - name: other\n    # keep provider comment\n    base_url: https://other.example\nagent:\n  max_turns: 5\n"
		default:
			if i == 0 {
				raw = "{\n// keep models comment\n\"providers\":{\"other\":{\"baseUrl\":\"https://other.example\"}}}"
			} else {
				raw = `{"defaultProvider":"other","defaultModel":"before","theme":"dark"}`
			}
		}
		if err := writeFileAtomic(target.Path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := loadAgentConfig(agent, ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestConfigureAgentsRestoreOriginalAndRepeatedBaseline(t *testing.T) {
	for _, agent := range configurableAgents {
		t.Run(agent, func(t *testing.T) {
			ctx := configureTestContext(t)
			files := seedAgentConfig(t, agent, ctx)
			original := make([][]byte, len(files))
			for i, file := range files {
				original[i] = append([]byte(nil), file.Raw...)
			}
			if err := buildAgentConfig(agent, ctx, files); err != nil {
				t.Fatal(err)
			}
			if err := saveClientConfig(agent, ctx.Profile.Name, files); err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				raw, _ := os.ReadFile(file.Path)
				if agent == "hermes" && !bytes.Contains(raw, []byte("# keep provider comment")) {
					t.Fatal("another provider's YAML comment was lost")
				}
				if _, err := os.Stat(file.Path + ".rai.bak"); err != nil {
					t.Fatal(err)
				}
			}
			ctx.Model = "model-b"
			files, err := loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if err := buildAgentConfig(agent, ctx, files); err != nil {
				t.Fatal(err)
			}
			if err := saveClientConfig(agent, ctx.Profile.Name, files); err != nil {
				t.Fatal(err)
			}
			files, err = loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if ok, err := restoreAgentConfig(agent, "work", files); !ok || err != nil {
				t.Fatalf("restore: %v", err)
			}
			for i, file := range files {
				raw, _ := os.ReadFile(file.Path)
				if !bytes.Equal(raw, original[i]) {
					t.Fatalf("original was not restored for %s", file.Path)
				}
			}
		})
	}
}

func TestConfigureRejectsInvalidAndConcurrentFiles(t *testing.T) {
	ctx := configureTestContext(t)
	targets, err := agentConfigTargets("claude", ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(targets[0].Path, []byte("{invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentConfig("claude", ctx.Environ); err == nil {
		t.Fatal("invalid configuration accepted")
	}
	files := seedAgentConfig(t, "claude", ctx)
	if err := buildAgentConfig("claude", ctx, files); err != nil {
		t.Fatal(err)
	}
	edit := []byte(`{"model":"user-edited"}`)
	if err := writeFileAtomic(files[0].Path, edit, 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("claude", "work", files); err == nil {
		t.Fatal("concurrent edit overwritten")
	}
	raw, _ := os.ReadFile(files[0].Path)
	if !bytes.Equal(raw, edit) {
		t.Fatal("concurrent edit lost")
	}
}

func TestConfigureHelpAndInvalidArgumentsDoNotAuthorize(t *testing.T) {
	for _, args := range [][]string{{"configure", "--help"}, {"configure", "pi", "--help"}, {"help", "configure"}, {"unconfigure", "pi", "--help"}} {
		a := &App{Args: args, Home: t.TempDir(), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatalf("help failed for %v: %v", args, err)
		}
	}
	for _, args := range [][]string{{"configure", "unknown"}, {"configure", "pi", "--bad"}, {"configure", "pi", "--model"}, {"configure", "pi", "--reasoning-effort=invalid"}, {"configure", "pi", "--codex-profile", "work"}} {
		a := &App{Args: args, Home: t.TempDir(), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
		if err := a.Execute(context.Background()); err == nil {
			t.Fatalf("invalid arguments accepted: %v", args)
		}
	}
}

func TestConfigureAgentsPreserveLaterEdits(t *testing.T) {
	for _, agent := range configurableAgents {
		t.Run(agent, func(t *testing.T) {
			ctx := configureTestContext(t)
			files := seedAgentConfig(t, agent, ctx)
			if err := buildAgentConfig(agent, ctx, files); err != nil {
				t.Fatal(err)
			}
			if err := saveClientConfig(agent, "work", files); err != nil {
				t.Fatal(err)
			}
			files, err := loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			file := files[len(files)-1]
			file.Document["user_note"] = "later edit"
			if agent == "claude" {
				if err := configSet(file.Document, []string{"env", "ANTHROPIC_BASE_URL"}, "https://edited.example"); err != nil {
					t.Fatal(err)
				}
			}
			raw, err := file.render(file.Document)
			if err != nil {
				t.Fatal(err)
			}
			if err := writeFileAtomic(file.Path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			files, err = loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if ok, err := restoreAgentConfig(agent, "work", files); !ok || err != nil {
				t.Fatal(err)
			}
			read, err := readClientConfig(file.Path, file.Format)
			if err != nil {
				t.Fatal(err)
			}
			if read.Document["user_note"] != "later edit" {
				t.Fatal("later user edit lost")
			}
			if agent == "claude" {
				token, _ := configValue(read.Document, []string{"env", "ANTHROPIC_AUTH_TOKEN"})
				if token == "old-private-key" {
					t.Fatal("old secret restored to edited endpoint")
				}
			}
		})
	}
}

func TestConfigureAgentsRemoveOriginallyMissingFiles(t *testing.T) {
	for _, agent := range configurableAgents {
		t.Run(agent, func(t *testing.T) {
			ctx := configureTestContext(t)
			files, err := loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if err := buildAgentConfig(agent, ctx, files); err != nil {
				t.Fatal(err)
			}
			if err := saveClientConfig(agent, "work", files); err != nil {
				t.Fatal(err)
			}
			files, err = loadAgentConfig(agent, ctx.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := restoreAgentConfig(agent, "", files); err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				if _, err := os.Stat(file.Path); !os.IsNotExist(err) {
					t.Fatal("new file remained after restoration")
				}
			}
		})
	}
}

func TestConfigureMultiFileFailureRollsBack(t *testing.T) {
	ctx := configureTestContext(t)
	files := seedAgentConfig(t, "pi", ctx)
	if err := buildAgentConfig("pi", ctx, files); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(files[1].Path+".rai.bak", 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveClientConfig("pi", "work", files); err == nil {
		t.Fatal("expected backup failure")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file.Path)
		if !bytes.Equal(raw, file.Raw) {
			t.Fatal("partial configuration survived rollback")
		}
		if _, err := os.Stat(clientConfigJournalPath(file.Path, "pi")); !os.IsNotExist(err) {
			t.Fatal("recovery record was not rolled back")
		}
	}
}

func TestConfigureAgentConfirmationAndDirectProxy(t *testing.T) {
	for _, accept := range []bool{false, true} {
		t.Run(map[bool]string{false: "decline", true: "accept"}[accept], func(t *testing.T) {
			t.Setenv(envDisableKey, "1")
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/rai/session" {
					io.WriteString(w, `{"models":["model-a"],"default_model":"model-a"}`)
					return
				}
				if r.URL.Path == "/v1/chat/completions" {
					if r.Header.Get("Authorization") != "Bearer rai_at_initial" {
						t.Error("proxy did not authenticate with upstream access token")
					}
					io.WriteString(w, `{}`)
					return
				}
				http.NotFound(w, r)
			}))
			defer gateway.Close()
			ctx := configureTestContext(t)
			var output bytes.Buffer
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			a := &App{Home: ctx.RAIHome, Self: binary, Environ: mergeEnv(os.Environ(), map[string]string{"HOME": environmentValue(ctx.Environ, "HOME"), "XDG_CONFIG_HOME": environmentValue(ctx.Environ, "XDG_CONFIG_HOME"), "RAI_TEST_PROXY_PROCESS": "1"}), Stdout: &output, Stderr: &output, Stdin: strings.NewReader("n\n")}
			a.defaults()
			store, profile := saveTestOAuth(t, a, gateway.URL, "inference", time.Now().Add(time.Hour))
			a.Args = []string{"configure", "opencode"}
			if accept {
				a.Args = append(a.Args, "--yes")
			}
			if err := a.Execute(context.Background()); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String(), "rai_at_initial") || strings.Contains(output.String(), "rai_rt_initial") {
				t.Fatal("token leaked to output")
			}
			files, err := loadAgentConfig("opencode", a.Environ)
			if err != nil {
				t.Fatal(err)
			}
			if !accept {
				if files[0].Raw != nil {
					t.Fatal("declined configuration changed a file")
				}
				if _, err := readProxyState(store, profile); !os.IsNotExist(err) {
					t.Fatal("declined configuration started a proxy")
				}
				return
			}
			if bytes.Contains(files[0].Raw, []byte("rai_at_initial")) || bytes.Contains(files[0].Raw, []byte("rai_rt_initial")) {
				t.Fatal("upstream OAuth credential persisted in native configuration")
			}
			state, err := readProxyState(store, profile)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _, _ = proxyRequest(context.Background(), state, http.MethodPost, "/_rai/stop") })
			if ok, err := proxyRequest(context.Background(), state, http.MethodPost, "/v1/chat/completions"); !ok || err != nil {
				t.Fatal("configured background proxy did not work")
			}
			var document map[string]any
			if json.Unmarshal(files[0].Raw, &document) != nil {
				t.Fatal("invalid saved JSON")
			}
			if !strings.HasSuffix(document["model"].(string), "/model-a") {
				t.Fatal("default model not selected")
			}
			a.Args = []string{"unconfigure", "opencode"}
			if err := a.Execute(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(files[0].Path); !os.IsNotExist(err) {
				t.Fatal("unconfigure did not remove newly created configuration")
			}
		})
	}
}
