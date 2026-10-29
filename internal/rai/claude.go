package rai

import (
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
	env := claudeGatewayEnv(ctx)
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
		"CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK":       "1",
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
		"CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT":           "1",
	}
	// Claude's background requests and model aliases are independent of
	// --model. Preserve an explicitly selected, authorized role model; replace
	// inherited defaults that this gateway cannot serve.
	for _, key := range []string{
		"ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
		"ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
		"ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
	} {
		model := environmentValue(ctx.Environ, key)
		if model == "" || !contains(ctx.Models, model) {
			model = ctx.Model
		}
		env[key] = model
		if info := ctx.ModelInfo[model]; info.Name != "" {
			env[key+"_NAME"] = info.Name
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
	if limit := ctx.ModelInfo[ctx.Model].MaxOutput; limit > 0 {
		if selected, err := strconv.Atoi(environmentValue(ctx.Environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")); err == nil && selected > 0 {
			limit = min(limit, selected)
		}
		env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = strconv.Itoa(limit)
	}
	if claudeToolSearch(ctx.Model) {
		env["ENABLE_TOOL_SEARCH"] = "true"
	} else {
		env["ENABLE_TOOL_SEARCH"] = "false"
	}
	return env
}

func claudeToolSearch(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(model, "anthropic/") {
		return true
	}
	return strings.HasPrefix(model, "claude-") || strings.Contains(model, "/claude-")
}
