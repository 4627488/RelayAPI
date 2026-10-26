package rai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func boolValue(v bool) *bool { return &v }

func TestAgentCapabilitiesAndCredentialIsolation(t *testing.T) {
	home := t.TempDir()
	ctx := LaunchContext{
		Profile: Profile{Name: "work", ServerURL: "https://relay.example", ReasoningEffort: "high"},
		RAIHome: t.TempDir(), RuntimeDir: t.TempDir(), APIBase: "http://127.0.0.1:1234", APIKey: "rai_local_test",
		Model: "custom-model", Models: []string{"custom-model", "image-only"},
		ModelInfo: map[string]ModelInfo{
			"custom-model": {Name: "Custom", Context: 131072, MaxInput: 120000, MaxOutput: 8192, Reasoning: boolValue(true), ToolCall: boolValue(true), InputModalities: []string{"text", "image"}, ReasoningLevels: []string{"low", "high"}},
			"image-only":   {ToolCall: boolValue(false)},
		},
		Executable: "/fake/client", Environ: []string{"HOME=" + home},
	}
	t.Run("opencode", func(t *testing.T) {
		command, err := (OpenCodeAdapter{}).Prepare(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var config struct {
			Provider map[string]struct {
				Models map[string]struct {
					Limit      map[string]int `json:"limit"`
					Reasoning  bool           `json:"reasoning"`
					Attachment bool           `json:"attachment"`
				} `json:"models"`
			} `json:"provider"`
		}
		if err := json.Unmarshal([]byte(environmentValue(command.Env, "OPENCODE_CONFIG_CONTENT")), &config); err != nil {
			t.Fatal(err)
		}
		models := config.Provider[providerID].Models
		model := models[ctx.Model]
		if len(models) != 1 || model.Limit["context"] != 131072 || model.Limit["output"] != 8192 || !model.Reasoning || !model.Attachment {
			t.Fatalf("capabilities missing: %+v", config)
		}
	})
	t.Run("pi", func(t *testing.T) {
		command, err := (PiAdapter{}).Prepare(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(command.Args, " "), "--provider relayapi") {
			t.Fatal("provider not pinned")
		}
		raw, err := os.ReadFile(filepath.Join(ctx.RuntimeDir, "relayapi-provider.js"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), ctx.APIKey) || strings.Contains(string(raw), "image-only") || !strings.Contains(string(raw), `"contextWindow":131072`) {
			t.Fatal("incorrect Pi model projection")
		}
	})
	t.Run("prime", func(t *testing.T) {
		dir := filepath.Join(home, ".prime", "agent")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "models.json")
		original := "{\n  \"providers\": {\"mine\": {\"baseUrl\": \"https://mine.example\"}}\n}\n"
		if err := os.WriteFile(path, []byte(original), 0600); err != nil {
			t.Fatal(err)
		}
		command, err := (PrimeAdapter{}).Prepare(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(command.Args, " "), "--provider "+launchProviderID(ctx)) {
			t.Fatal("provider not pinned")
		}
		raw, _ := os.ReadFile(path)
		if !strings.Contains(string(raw), `"mine": {"baseUrl": "https://mine.example"}`) {
			t.Fatal("user provider changed")
		}
		if strings.Contains(strings.Join(command.Env, " "), "rai_local_test") {
			t.Fatal("Prime should read local credential from its config")
		}
		if err := mergeClientProvider(path, launchProviderID(ctx), nil); err != nil {
			t.Fatal(err)
		}
		raw, _ = os.ReadFile(path)
		if strings.Contains(string(raw), launchProviderID(ctx)) || !strings.Contains(string(raw), `"mine"`) {
			t.Fatal("unconfigure removed another provider")
		}
	})
	t.Run("hermes", func(t *testing.T) {
		dir := filepath.Join(home, ".hermes")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "config.yaml")
		if err := os.WriteFile(path, []byte("# my preferences\nmodel: old-model\ncustom_providers:\n  - name: mine\n    base_url: https://mine.example\n"), 0600); err != nil {
			t.Fatal(err)
		}
		command, err := (HermesAdapter{}).Prepare(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(command.Args, " "), "--provider custom:"+launchProviderID(ctx)) {
			t.Fatal("provider not pinned")
		}
		raw, _ := os.ReadFile(path)
		if !strings.Contains(string(raw), "# my preferences") || !strings.Contains(string(raw), "https://mine.example") || !strings.Contains(string(raw), "api_mode: chat_completions") {
			t.Fatal("user configuration lost or routing missing")
		}
		if _, err := (HermesAdapter{}).Prepare(ctx); err != nil {
			t.Fatal(err)
		}
		raw, _ = os.ReadFile(path)
		if strings.Count(string(raw), "name: "+launchProviderID(ctx)) != 1 {
			t.Fatal("provider duplicated")
		}
		if err := mergeHermesProvider(path, launchProviderID(ctx), nil); err != nil {
			t.Fatal(err)
		}
		raw, _ = os.ReadFile(path)
		if strings.Contains(string(raw), launchProviderID(ctx)) || !strings.Contains(string(raw), "https://mine.example") {
			t.Fatal("unconfigure removed another provider")
		}
	})
}

func TestDaemonAdaptersCannotPersistUpstreamCredentials(t *testing.T) {
	for _, adapter := range []Adapter{HermesAdapter{}, PrimeAdapter{}} {
		if _, err := adapter.Prepare(LaunchContext{APIBase: "https://relay.example", APIKey: "rai_at_secret"}); err == nil {
			t.Fatalf("%s accepted an upstream bearer for persistent configuration", adapter.Name())
		}
	}
}

func TestClaudeBackgroundModelsAreAuthorized(t *testing.T) {
	command, err := (ClaudeAdapter{}).Prepare(LaunchContext{
		Executable: "/fake/claude", Model: "custom", Models: []string{"custom", "cheap"}, APIBase: "https://relay.example",
		Environ: []string{"ANTHROPIC_DEFAULT_HAIKU_MODEL=cheap", "CLAUDE_CODE_SUBAGENT_MODEL=unavailable"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if environmentValue(command.Env, "ANTHROPIC_DEFAULT_HAIKU_MODEL") != "cheap" || environmentValue(command.Env, "CLAUDE_CODE_SUBAGENT_MODEL") != "custom" || environmentValue(command.Env, "ANTHROPIC_DEFAULT_OPUS_MODEL") != "custom" {
		t.Fatal("background model mapping escaped authorized catalog")
	}
}

func TestPrimePreservesCommentedModelsJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	raw := []byte("{\n// my providers\n\"providers\": {\"mine\": {\"baseUrl\":\"https://example.test/a//b\",},},\n}\n")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := mergeClientProvider(path, "rai_test", map[string]any{"baseUrl": "http://127.0.0.1:1/v1"}); err != nil {
		t.Fatal(err)
	}
	updated, _ := os.ReadFile(path)
	if !strings.Contains(string(updated), "// my providers") || !strings.Contains(string(updated), "https://example.test/a//b") {
		t.Fatal("user comments or URLs were rewritten")
	}
	var doc map[string]any
	if err := json.Unmarshal(cleanClientJSON(updated), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc["providers"].(map[string]any)) != 2 {
		t.Fatal("providers lost")
	}
}

func TestLaunchModelAndReasoningOptions(t *testing.T) {
	effort, args, err := splitLaunchEffort([]string{"--reasoning-effort", "high", "--model", "main", "--", "-m", "native"})
	if err != nil || effort != "high" {
		t.Fatal("effort not extracted")
	}
	_, rest, err := splitLaunchArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	model, err := nativeLaunchModel(rest)
	if err != nil || model != "native" {
		t.Fatal("native model override lost")
	}
	if model, err := nativeLaunchModel([]string{"-p", "--model"}); err != nil || model != "" {
		t.Fatal("prompt parsed as an option")
	}
	if _, _, err := splitLaunchEffort([]string{"--reasoning-effort=invalid"}); err == nil {
		t.Fatal("invalid effort accepted")
	}
}

func TestManagedProxyReloadsProfilesAndRejectsOtherOrigins(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer second" {
			t.Errorf("credential was not reloaded")
		}
		io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profile := Profile{Name: "work", ServerURL: upstream.URL}
	if err := store.PutProfile(profile); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutCredential(profile.Name, "first"); err != nil {
		t.Fatal(err)
	}
	a := &App{}
	a.defaults()
	server, listener, token, err := a.newProfileProxy(context.Background(), store, profile, true)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(listener)
	state := proxyState{URL: "http://" + listener.Addr().String(), Token: token}
	if _, err := store.PutCredential(profile.Name, "second"); err != nil {
		t.Fatal(err)
	}
	if ok, err := proxyRequest(context.Background(), state, http.MethodGet, "/v1/models"); !ok || err != nil {
		t.Fatalf("proxy failed: %v", err)
	}
	if ok, _ := proxyRequest(context.Background(), state, http.MethodGet, "/api/rai/keys"); ok {
		t.Fatal("account endpoint exposed")
	}
	profile.ServerURL = "https://another.example"
	if err := store.PutProfile(profile); err != nil {
		t.Fatal(err)
	}
	if ok, _ := proxyRequest(context.Background(), state, http.MethodGet, "/v1/models"); ok {
		t.Fatal("proxy crossed profile origin")
	}
	state.URL = "https://remote.example"
	if _, err := proxyRequest(context.Background(), state, http.MethodGet, "/_rai/health"); err == nil {
		t.Fatal("remote state accepted")
	}
}
