package rai

import (
	"encoding/json"
	"errors"
)

type GrokAdapter struct{}

func (GrokAdapter) Name() string    { return "grok" }
func (GrokAdapter) Install() string { return "npm install -g @xai-official/grok" }
func (a GrokAdapter) Probe() (string, string, error) {
	return (EnvAdapter{BinaryName: "grok", InstallHint: a.Install()}).Probe()
}
func (a GrokAdapter) Prepare(ctx LaunchContext) (Command, error) {
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
		models[role] = ctx.Model
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
	command, err := (EnvAdapter{BinaryName: "grok", InstallHint: a.Install(), Env: grokEnv, PassModel: true}).Prepare(ctx)
	if err != nil {
		return Command{}, err
	}
	command.Env = mergeEnv(command.Env, map[string]string{
		"GROK_CONFIG": string(raw), "GROK_DEFAULT_MODEL": ctx.Model, "GROK_WEB_SEARCH_MODEL": ctx.Model,
		"GROK_MODELS_LIST_URL": v1APIBase(ctx.APIBase) + "/models",
	})
	return command, nil
}
