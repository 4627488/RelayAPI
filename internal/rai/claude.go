package rai

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
)

type ClaudeAdapter struct{}

func (ClaudeAdapter) Name() string { return "claude" }

func (ClaudeAdapter) Install() string { return "npm install -g @anthropic-ai/claude-code" }

func (ClaudeAdapter) Probe() (string, string, error) {
	path, err := lookPath("claude")
	if err != nil {
		return "", "", missingBinary("claude", ClaudeAdapter{}.Install())
	}
	return path, probeVersion(path), nil
}

func (ClaudeAdapter) Prepare(ctx LaunchContext) (Command, error) {
	path := ctx.Executable
	if path == "" {
		var err error
		path, err = lookPath("claude")
		if err != nil {
			return Command{}, missingBinary("claude", ClaudeAdapter{}.Install())
		}
	}
	args := append([]string(nil), ctx.Args...)
	if ctx.Model != "" && !hasModelFlag(args) {
		args = append([]string{"--model", ctx.Model}, args...)
	}
	if ctx.RuntimeDir != "" {
		files, err := loadAgentConfig("claude", ctx.Environ)
		if err != nil {
			return Command{}, err
		}
		ctx = claudeSettingsContext(ctx, files[0].Document)
	}
	env := claudeGatewayEnv(ctx)
	// A user settings file can override process environment variables. Give
	// this launch its own settings overlay without putting credentials in argv.
	if ctx.RuntimeDir != "" {
		raw, err := json.Marshal(map[string]any{"env": env, "model": ctx.Model})
		if err != nil {
			return Command{}, err
		}
		settings := filepath.Join(ctx.RuntimeDir, "claude-settings.json")
		if err := writeFileAtomic(settings, raw, 0o600); err != nil {
			return Command{}, err
		}
		args = append([]string{"--settings", settings}, args...)
	}
	return Command{
		Path: path,
		Args: args,
		Env:  mergeEnv(ctx.Environ, env),
	}, nil
}

func claudeGatewayEnv(ctx LaunchContext) map[string]string {
	env := map[string]string{
		envAPIKey:                                    ctx.APIKey,
		envProfile:                                   ctx.Profile.Name,
		"ANTHROPIC_BASE_URL":                         strings.TrimRight(ctx.APIBase, "/"),
		"ANTHROPIC_AUTH_TOKEN":                       ctx.APIKey,
		"ANTHROPIC_API_KEY":                          "",
		"CLAUDE_CODE_USE_BEDROCK":                    "0",
		"CLAUDE_CODE_USE_VERTEX":                     "0",
		"CLAUDE_CODE_USE_FOUNDRY":                    "0",
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
		"CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT":           "0",
		"CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK":       "0",
	}
	// Claude's background requests and model aliases are independent of
	// --model. Preserve an explicitly selected, authorized role model; replace
	// inherited defaults that this gateway cannot serve.
	for key, fallback := range claudeRoleModels(ctx) {
		model := environmentValue(ctx.Environ, key)
		if model == "" || !contains(ctx.Models, model) || !agentCapable(ctx.ModelInfo[model]) || (ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) != "" && ClaudeModelFamily(model, ctx.ModelInfo[model]) == "") {
			model = fallback
		}
		env[key] = model
		if info := ctx.ModelInfo[model]; info.Name != "" {
			env[key+"_NAME"] = info.Name
		} else {
			env[key+"_NAME"] = ""
		}
	}
	if level := ctx.Profile.ReasoningEffort; level != "" {
		switch level {
		case "none":
			env["MAX_THINKING_TOKENS"] = "0"
		case "minimal":
			env["CLAUDE_CODE_EFFORT_LEVEL"] = "low"
		case "ultra":
			env["CLAUDE_CODE_EFFORT_LEVEL"] = "max"
		default:
			env["CLAUDE_CODE_EFFORT_LEVEL"] = level
		}
	}
	// Known Claude models already have client defaults. A maximum supported
	// output is not a request budget; custom model IDs still need a safe cap.
	if limit := ctx.ModelInfo[ctx.Model].MaxOutput; limit > 0 && ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) == "" {
		if selected, err := strconv.Atoi(environmentValue(ctx.Environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")); err == nil && selected > 0 {
			limit = min(limit, selected)
		}
		env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = strconv.Itoa(limit)
	} else if ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) != "" {
		// An empty overlay value also clears an old rai-generated user setting.
		env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = environmentValue(ctx.Environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")
	}
	if claudeToolSearch(ClaudeModelID(ctx.Model, ctx.ModelInfo[ctx.Model])) {
		env["ENABLE_TOOL_SEARCH"] = "auto"
	} else {
		env["ENABLE_TOOL_SEARCH"] = "false"
	}
	return env
}

func claudeGeneratedOutputBudget(ctx LaunchContext, doc map[string]any) bool {
	legacy, _ := configValue(doc, []string{"env", "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT"})
	if legacy != "1" {
		return false
	}
	model, _ := doc["model"].(string)
	limit := ctx.ModelInfo[model].MaxOutput
	if limit == 0 {
		limit = ctx.ModelInfo[ctx.Model].MaxOutput
	}
	value, _ := configValue(doc, []string{"env", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"})
	return limit > 0 && value == strconv.Itoa(limit)
}

func claudeSettingsContext(ctx LaunchContext, doc map[string]any) LaunchContext {
	configured := map[string]string{}
	keys := []string{}
	for key := range claudeRoleModels(ctx) {
		keys = append(keys, key)
	}
	if !claudeGeneratedOutputBudget(ctx, doc) {
		keys = append(keys, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")
	}
	for _, key := range keys {
		if environmentValue(ctx.Environ, key) == "" {
			if value, ok := configValue(doc, []string{"env", key}); ok {
				if value, ok := value.(string); ok {
					configured[key] = value
				}
			}
		}
	}
	ctx.Environ = mergeEnv(ctx.Environ, configured)
	return ctx
}

func claudeToolSearch(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(model, "anthropic/") {
		return true
	}
	return strings.HasPrefix(model, "claude-") || strings.Contains(model, "/claude-")
}
