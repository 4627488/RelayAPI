package rai

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var configurableAgents = []string{"claude", "opencode", "grok", "pi", "hermes", "prime-agent"}

type clientConfigTarget struct{ Path, Format string }

func agentConfigTargets(agent string, environ []string) ([]clientConfigTarget, error) {
	var dir string
	var err error
	switch agent {
	case "claude":
		dir, err = clientHome(environ, "CLAUDE_CONFIG_DIR", ".claude")
	case "grok":
		dir, err = clientHome(environ, "GROK_HOME", ".grok")
	case "pi":
		dir, err = clientHome(environ, "PI_CODING_AGENT_DIR", ".pi/agent")
	case "prime-agent":
		dir, err = clientHome(environ, "PRIME_AGENT_CODING_AGENT_DIR", ".prime/agent")
	case "hermes":
		dir, err = clientHome(environ, "HERMES_HOME", ".hermes")
	case "opencode":
		if explicit := environmentValue(environ, "OPENCODE_CONFIG"); explicit != "" {
			path, e := filepath.Abs(explicit)
			return []clientConfigTarget{{path, "json"}}, e
		}
		base := environmentValue(environ, "XDG_CONFIG_HOME")
		if base == "" {
			base, err = clientHome(environ, "", ".config")
		}
		dir = filepath.Join(base, "opencode")
	default:
		return nil, fmt.Errorf("unsupported configure target %q", agent)
	}
	if err != nil {
		return nil, err
	}
	file := func(name, format string) clientConfigTarget {
		return clientConfigTarget{filepath.Join(dir, name), format}
	}
	switch agent {
	case "claude":
		return []clientConfigTarget{file("settings.json", "json")}, nil
	case "grok":
		return []clientConfigTarget{file("config.toml", "toml")}, nil
	case "hermes":
		return []clientConfigTarget{file("config.yaml", "yaml")}, nil
	case "opencode":
		// jsonc is loaded after json by OpenCode when both files exist.
		if _, err := os.Stat(filepath.Join(dir, "opencode.jsonc")); err == nil {
			return []clientConfigTarget{file("opencode.jsonc", "json")}, nil
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		return []clientConfigTarget{file("opencode.json", "json")}, nil
	default:
		return []clientConfigTarget{file("models.json", "json"), file("settings.json", "json")}, nil
	}
}

func loadAgentConfig(agent string, environ []string) ([]*clientConfigFile, error) {
	targets, err := agentConfigTargets(agent, environ)
	if err != nil {
		return nil, err
	}
	files := make([]*clientConfigFile, 0, len(targets))
	for _, target := range targets {
		file, err := readClientConfig(target.Path, target.Format)
		if err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	return files, nil
}

func buildAgentConfig(agent string, ctx LaunchContext, files []*clientConfigFile) error {
	if err := requireLocalClientCredential(ctx); err != nil {
		return err
	}
	id := launchProviderID(ctx)
	set := func(f *clientConfigFile, value any, path ...string) error { return configSet(f.Document, path, value) }
	first := files[0]
	switch agent {
	case "claude":
		// Reuse the launch adapter's gateway contract, without inheriting
		// unrelated shell variables into the persistent settings file.
		for key, value := range claudeGatewayEnv(ctx) {
			if key == envAPIKey || key == envProfile {
				continue
			}
			if err := set(first, value, "env", key); err != nil {
				return err
			}
		}
		configDelete(first.Document, "apiKeyHelper")
		return set(first, ctx.Model, "model")
	case "opencode":
		config := openCodeConfig(ctx, id, ctx.APIKey)
		provider := config["provider"].(map[string]any)[id]
		if err := set(first, provider, "provider", id); err != nil {
			return err
		}
		if err := set(first, config["model"], "model"); err != nil {
			return err
		}
		return set(first, config["model"], "small_model")
	case "pi", "prime-agent":
		provider := map[string]any{"name": "RelayAPI (" + ctx.Profile.Name + ")", "api": "openai-completions", "baseUrl": v1APIBase(ctx.APIBase), "apiKey": ctx.APIKey, "models": piModels(ctx)}
		if err := set(first, provider, "providers", id); err != nil {
			return err
		}
		if err := set(files[1], id, "defaultProvider"); err != nil {
			return err
		}
		if err := set(files[1], ctx.Model, "defaultModel"); err != nil {
			return err
		}
		if ctx.Profile.ReasoningEffort != "" {
			return set(files[1], piThinkingLevel(ctx.Profile.ReasoningEffort), "defaultThinkingLevel")
		}
	case "hermes":
		if window := ctx.ModelInfo[ctx.Model].Context; window > 0 && window < 64000 {
			return errors.New("Hermes requires at least 64000 context tokens")
		}
		entry := map[string]any{"name": id, "base_url": v1APIBase(ctx.APIBase), "api_key": ctx.APIKey, "api_mode": "chat_completions", "model": ctx.Model}
		if window := ctx.ModelInfo[ctx.Model].Context; window > 0 {
			entry["context_length"] = window
		}
		var entries []any
		if raw, exists := first.Document["custom_providers"]; exists {
			var ok bool
			entries, ok = raw.([]any)
			if !ok {
				return errors.New("Hermes custom_providers must be a list")
			}
		}
		replaced := false
		for i, raw := range entries {
			if item, ok := raw.(map[string]any); ok && item["name"] == id {
				entries[i] = entry
				replaced = true
				break
			}
		}
		if !replaced {
			entries = append(entries, entry)
		}
		first.Document["custom_providers"] = entries
		if _, ok := first.Document["model"].(string); ok {
			first.Document["model"] = map[string]any{}
		}
		for _, key := range []string{"base_url", "api_key", "api_mode"} {
			configDelete(first.Document, "model", key)
		}
		if err := set(first, "custom:"+id, "model", "provider"); err != nil {
			return err
		}
		if err := set(first, ctx.Model, "model", "default"); err != nil {
			return err
		}
		if ctx.Profile.ReasoningEffort != "" {
			return set(first, ctx.Profile.ReasoningEffort, "agent", "reasoning_effort")
		}
	case "grok":
		selected := ""
		for _, model := range agentModels(ctx) {
			alias := id + "_" + fmt.Sprintf("%x", sha256.Sum256([]byte(model)))[:12]
			info := ctx.ModelInfo[model]
			entry := map[string]any{"model": model, "name": model + " (RelayAPI)", "base_url": v1APIBase(ctx.APIBase), "api_key": ctx.APIKey, "api_backend": "chat_completions"}
			if info.Context > 0 {
				entry["context_window"] = info.Context
			}
			if info.MaxOutput > 0 {
				entry["max_completion_tokens"] = info.MaxOutput
			}
			if err := set(first, entry, "model", alias); err != nil {
				return err
			}
			if model == ctx.Model {
				selected = alias
			}
		}
		if selected == "" {
			return errors.New("selected model cannot run an agent")
		}
		for _, role := range []string{"default", "session_summary", "image_description", "prompt_suggestion", "web_search"} {
			if err := set(first, selected, "models", role); err != nil {
				return err
			}
		}
		if ctx.Profile.ReasoningEffort != "" {
			return set(first, ctx.Profile.ReasoningEffort, "models", "default_reasoning_effort")
		}
	default:
		return fmt.Errorf("unsupported configure target %q", agent)
	}
	return nil
}

func configureUsage() string {
	return "rai configure <codex|" + strings.Join(configurableAgents, "|") + "> [--server <url>] [--model <id>] [--reasoning-effort <level>] [--no-browser] [-y|--yes]"
}
