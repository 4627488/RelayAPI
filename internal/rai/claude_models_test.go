package rai

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestClaudeSelectsNativeModelsWithoutChangingOtherClients(t *testing.T) {
	models := []string{"gpt-main", "claude-sonnet-4-9", "claude-sonnet-4-10", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-99-0"}
	info := map[string]ModelInfo{"claude-sonnet-99-0": {ToolCall: boolValue(false)}}
	profile := Profile{DefaultModel: "gpt-main"}
	for _, agent := range []string{"claude", "claude-desktop", "codex", "opencode"} {
		model, err := resolveAgentModel(agent, profile, "", models, info, "gpt-main")
		want := "gpt-main"
		if strings.HasPrefix(agent, "claude") {
			want = "claude-sonnet-4-10"
		}
		if err != nil || model != want {
			t.Fatalf("%s selected %q, %v; want %s", agent, model, err, want)
		}
	}
	for _, requested := range []string{"claude-opus-5-5", "gpt-main"} {
		model, err := resolveAgentModel("claude", profile, requested, models, info, "gpt-main")
		if err != nil || model != requested {
			t.Fatalf("explicit model %s was not honored: %s, %v", requested, model, err)
		}
	}
	if _, err := resolveAgentModel("claude", profile, "missing", models, info, "gpt-main"); err == nil {
		t.Fatal("unauthorized explicit model accepted")
	}
	profile.DefaultModel = "claude-sonnet-4-9"
	if got, _ := resolveAgentModel("claude", profile, "", models, info, "gpt-main"); got != profile.DefaultModel {
		t.Fatal("explicit Claude profile preference was replaced")
	}
	if compareClaudeModels("team999/claude-sonnet-4-6", "team1/claude-sonnet-5-5") >= 0 {
		t.Fatal("gateway prefix affected version ordering")
	}
}

func TestClaudeNativeRolesAndLaunchSettingsOverrideStaleUserConfig(t *testing.T) {
	ctx := LaunchContext{
		Executable: "/fake/claude", RuntimeDir: t.TempDir(), APIBase: "https://relay.example", APIKey: "private-test-token",
		Model: "claude-sonnet-5-5", Models: []string{"gpt-main", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"},
		ModelInfo: map[string]ModelInfo{"claude-sonnet-5-5": {MaxOutput: 128000}},
		Environ:   []string{"HOME=" + t.TempDir(), "ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-main", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME=GPT", "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1"},
	}
	command, err := (ClaudeAdapter{}).Prepare(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if command.Args[0] != "--settings" || strings.Contains(strings.Join(command.Args, " "), ctx.APIKey) {
		t.Fatal("missing settings overlay, or credential leaked in argv")
	}
	raw, err := os.ReadFile(command.Args[1])
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5", "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
		"ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "", "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT": "0", "ENABLE_TOOL_SEARCH": "auto",
	} {
		if settings.Env[key] != want {
			t.Fatalf("%s = %q, want %q", key, settings.Env[key], want)
		}
	}
	stat, _ := os.Stat(command.Args[1])
	if stat.Mode().Perm() != 0o600 {
		t.Fatal("launch credential file is not private")
	}
}

func TestClaudeConfigureMigratesOldDefaultsAndPreservesUserChoices(t *testing.T) {
	ctx := configureTestContext(t)
	ctx.Model = "claude-sonnet-5-5"
	ctx.Models = []string{ctx.Model, "gpt-main", "claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5"}
	ctx.ModelInfo[ctx.Model] = ModelInfo{MaxOutput: 128000}
	files, err := loadAgentConfig("claude", ctx.Environ)
	if err != nil {
		t.Fatal(err)
	}
	files[0].Document["env"] = map[string]any{
		"ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5", "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-main",
		"CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT": "1", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128000",
	}
	if err := buildAgentConfig("claude", ctx, files); err != nil {
		t.Fatal(err)
	}
	env := files[0].Document["env"].(map[string]any)
	if env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] != "claude-haiku-4-5" || env["ANTHROPIC_DEFAULT_OPUS_MODEL"] != "claude-opus-5-5" {
		t.Fatal("valid role preference lost or stale GPT mapping retained")
	}
	if _, exists := env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]; exists {
		t.Fatal("old generated output ceiling survived migration")
	}
	env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "4096"
	if err := buildAgentConfig("claude", ctx, files); err != nil {
		t.Fatal(err)
	}
	if env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] != "4096" {
		t.Fatal("user output budget was overwritten")
	}
}

func TestClaudeLaunchPreservesUserOutputBudgetInSettings(t *testing.T) {
	for _, budget := range []string{"128000", "4096"} {
		ctx := configureTestContext(t)
		ctx.Model = "claude-sonnet-5-5"
		ctx.Models = []string{ctx.Model}
		ctx.ModelInfo[ctx.Model] = ModelInfo{MaxOutput: 128000}
		ctx.Executable, ctx.RuntimeDir = "/fake/claude", t.TempDir()
		files, _ := loadAgentConfig("claude", ctx.Environ)
		doc := map[string]any{"env": map[string]any{"CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT": "1", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": budget}}
		raw, _ := json.Marshal(doc)
		if err := writeFileAtomic(files[0].Path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		command, err := (ClaudeAdapter{}).Prepare(ctx)
		if err != nil {
			t.Fatal(err)
		}
		want := budget
		if budget == "128000" {
			want = ""
		}
		if got := environmentValue(command.Env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"); got != want {
			t.Fatalf("budget %s became %s; want %s", budget, got, want)
		}
	}
}
