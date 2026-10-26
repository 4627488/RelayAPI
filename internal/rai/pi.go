package rai

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type PiAdapter struct{}

func (PiAdapter) Name() string    { return "pi" }
func (PiAdapter) Install() string { return "npm install -g @earendil-works/pi-coding-agent" }
func (a PiAdapter) Probe() (string, string, error) {
	return (EnvAdapter{BinaryName: "pi", InstallHint: a.Install()}).Probe()
}

func (a PiAdapter) Prepare(ctx LaunchContext) (Command, error) {
	if hasFlag(ctx.Args, "--provider", "--api-key") {
		return Command{}, errors.New("rai manages Pi provider and credentials; select the model with --model")
	}
	if ctx.RuntimeDir == "" {
		return Command{}, errors.New("Pi launch requires a runtime directory")
	}
	config := map[string]any{
		"name": "RelayAPI", "api": "openai-completions",
		"baseUrl": v1APIBase(ctx.APIBase), "apiKey": "$RAI_API_KEY",
		"models": piModels(ctx),
	}
	data, err := json.Marshal(config)
	if err != nil {
		return Command{}, err
	}
	path := filepath.Join(ctx.RuntimeDir, "relayapi-provider.js")
	// No imports ties this to neither the old nor the new Pi package name.
	source := "export default function(pi) { pi.registerProvider('relayapi', " + string(data) + "); }\n"
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		return Command{}, err
	}
	args := append([]string{"--extension", path, "--provider", "relayapi"}, ctx.Args...)
	if ctx.Profile.ReasoningEffort != "" && !hasFlag(args, "--thinking") {
		level := piThinkingLevel(ctx.Profile.ReasoningEffort)
		args = append([]string{"--thinking", level}, args...)
	}
	ctx.Args = args
	return (EnvAdapter{BinaryName: "pi", InstallHint: a.Install(), Env: openAICompatibleEnv, PassModel: true}).Prepare(ctx)
}

// Pi requires limits and cost fields even when the server has no facts. Use
// conservative limits in that case; zero cost means unknown, not a free plan.
func piModels(ctx LaunchContext) []map[string]any {
	models := make([]map[string]any, 0, len(ctx.Models))
	for _, id := range agentModels(ctx) {
		info := ctx.ModelInfo[id]
		name, window, output := info.Name, info.Context, info.MaxOutput
		if name == "" {
			name = id
		}
		if window <= 0 {
			window = 32768
		}
		if output <= 0 {
			output = min(4096, window/4)
		}
		input := []string{"text"}
		if contains(info.InputModalities, "image") {
			input = append(input, "image")
		}
		reasoning := info.Reasoning != nil && *info.Reasoning
		models = append(models, map[string]any{
			"id": id, "name": name, "reasoning": reasoning, "input": input,
			"contextWindow": window, "maxTokens": output,
			"cost": map[string]int{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
		})
	}
	return models
}
