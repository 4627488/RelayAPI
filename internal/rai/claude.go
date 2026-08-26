package rai

import "strings"

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
	env := map[string]string{
		envAPIKey:                              ctx.APIKey,
		envProfile:                             ctx.Profile.Name,
		"ANTHROPIC_BASE_URL":                   strings.TrimRight(ctx.APIBase, "/"),
		"ANTHROPIC_AUTH_TOKEN":                 ctx.APIKey,
		"ANTHROPIC_API_KEY":                    "",
		"CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK": "1",
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
		"CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT":           "1",
	}
	if claudeToolSearch(ctx.Model) {
		env["ENABLE_TOOL_SEARCH"] = "true"
	} else {
		env["ENABLE_TOOL_SEARCH"] = "false"
	}
	return Command{
		Path: path,
		Args: args,
		Env:  mergeEnv(ctx.Environ, env),
	}, nil
}

func claudeToolSearch(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(model, "anthropic/") {
		return true
	}
	return strings.HasPrefix(model, "claude-") || strings.Contains(model, "/claude-")
}
