package rai

import (
	"encoding/json"
	"errors"
	"strings"
)

type GrokAdapter struct{}

func (GrokAdapter) Name() string    { return "grok" }
func (GrokAdapter) Install() string { return "npm install -g @xai-official/grok" }
func (a GrokAdapter) Probe() (string, string, error) {
	return (EnvAdapter{BinaryName: "grok", InstallHint: a.Install()}).Probe()
}
func (a GrokAdapter) Prepare(ctx LaunchContext) (Command, error) {
	// Register the selected model synchronously. Grok's npm cold start can
	// check sign-in before its asynchronous remote catalog has loaded. Keep
	// launch-only entries separate from a persistent configure's credentials.
	files, err := loadAgentConfig("grok", ctx.Environ)
	if err != nil {
		return Command{}, err
	}
	alias := grokModelAlias(launchProviderID(ctx)+"_launch", ctx.Model)
	entry := grokModelConfig(ctx, ctx.Model)
	entry["env_key"] = envAPIKey
	if err := configSet(files[0].Document, []string{"model", alias}, entry); err != nil {
		return Command{}, err
	}
	config := map[string]any{}
	if raw := environmentValue(ctx.Environ, "GROK_CONFIG"); raw != "" {
		if json.Unmarshal([]byte(raw), &config) != nil || config == nil {
			return Command{}, errors.New("invalid GROK_CONFIG; fix its JSON before launching rai grok")
		}
	}
	models, ok := config["models"].(map[string]any)
	if !ok {
		models = map[string]any{}
	}
	for _, role := range []string{"default", "session_summary", "image_description", "prompt_suggestion", "web_search"} {
		models[role] = alias
	}
	if ctx.Profile.ReasoningEffort != "" {
		models["default_reasoning_effort"] = ctx.Profile.ReasoningEffort
	}
	if limit := ctx.ModelInfo[ctx.Model].MaxOutput; limit > 0 {
		models["max_completion_tokens"] = limit
	}
	config["models"] = models
	raw, err := json.Marshal(config)
	if err != nil {
		return Command{}, err
	}
	if err := saveClientConfig("grok", ctx.Profile.Name, files); err != nil {
		return Command{}, err
	}
	ctx.Args = append([]string(nil), ctx.Args...)
	for i := 0; i < len(ctx.Args); i++ {
		if ctx.Args[i] == "--" {
			break
		}
		name, value, inline := strings.Cut(ctx.Args[i], "=")
		if contains([]string{"-p", "--single", "--prompt", "--system-prompt", "--system-prompt-override", "--prompt-json", "--prompt-file"}, name) {
			if !inline {
				i++
			}
			continue
		}
		if name != "--model" && name != "-m" {
			continue
		}
		if inline {
			if value == ctx.Model {
				ctx.Args[i] = name + "=" + alias
			}
		} else if i+1 < len(ctx.Args) {
			i++
			if ctx.Args[i] == ctx.Model {
				ctx.Args[i] = alias
			}
		}
	}
	ctx.Model = alias
	command, err := (EnvAdapter{BinaryName: "grok", InstallHint: a.Install(), Env: grokEnv, PassModel: true}).Prepare(ctx)
	if err != nil {
		return Command{}, err
	}
	command.Env = mergeEnv(command.Env, map[string]string{
		"GROK_CONFIG": string(raw), "GROK_DEFAULT_MODEL": alias, "GROK_WEB_SEARCH_MODEL": alias,
		"GROK_MODELS_LIST_URL": v1APIBase(ctx.APIBase) + "/models",
	})
	return command, nil
}
