package rai

import (
	"encoding/json"
	"strings"
)

type OpenCodeAdapter struct{}

func (OpenCodeAdapter) Name() string { return "opencode" }

func (OpenCodeAdapter) Install() string { return "npm install -g opencode-ai" }

func (OpenCodeAdapter) Probe() (string, string, error) {
	path, err := lookPath("opencode")
	if err != nil {
		return "", "", missingBinary("opencode", OpenCodeAdapter{}.Install())
	}
	return path, probeVersion(path), nil
}

func (OpenCodeAdapter) Prepare(ctx LaunchContext) (Command, error) {
	path := ctx.Executable
	if path == "" {
		var err error
		path, err = lookPath("opencode")
		if err != nil {
			return Command{}, err
		}
	}
	npmPackage := "@ai-sdk/openai"
	if openCodeProtocol(ctx.Profile) == "chat" {
		npmPackage = "@ai-sdk/openai-compatible"
	}
	models := agentModels(ctx)
	openCodeModels := make(map[string]any, len(models))
	for _, model := range models {
		info := ctx.ModelInfo[model]
		entry := map[string]any{"name": model}
		if info.Name != "" {
			entry["name"] = info.Name
		}
		limit := map[string]int{}
		if info.Context > 0 {
			limit["context"] = info.Context
		}
		if info.MaxInput > 0 {
			limit["input"] = info.MaxInput
		}
		if info.MaxOutput > 0 {
			limit["output"] = info.MaxOutput
		}
		if len(limit) > 0 {
			entry["limit"] = limit
		}
		if info.Reasoning != nil {
			entry["reasoning"] = *info.Reasoning
		}
		if ctx.Profile.ReasoningEffort != "" && (info.Reasoning == nil || *info.Reasoning) {
			entry["options"] = map[string]any{"reasoningEffort": ctx.Profile.ReasoningEffort}
		}
		if info.ToolCall != nil {
			entry["toolcall"] = *info.ToolCall
		}
		if len(info.InputModalities) > 0 {
			entry["modalities"] = map[string]any{"input": info.InputModalities, "output": []string{"text"}}
			entry["attachment"] = contains(info.InputModalities, "image")
		}
		variants := map[string]any{}
		for _, level := range info.ReasoningLevels {
			variants[level] = map[string]any{"reasoningEffort": level}
		}
		if len(variants) > 0 {
			entry["variants"] = variants
		}
		openCodeModels[model] = entry
	}
	content, err := json.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"model":   providerID + "/" + ctx.Model,
		"provider": map[string]any{
			providerID: map[string]any{
				"npm":  npmPackage,
				"name": "RelayAPI",
				"options": map[string]any{
					"baseURL": strings.TrimRight(ctx.APIBase, "/") + "/v1",
					"apiKey":  "{env:" + envAPIKey + "}",
				},
				"models": openCodeModels,
			},
		},
	})
	if err != nil {
		return Command{}, err
	}
	return Command{
		Path: path,
		Args: append([]string(nil), ctx.Args...),
		Env: mergeEnv(ctx.Environ, map[string]string{
			envAPIKey:                 ctx.APIKey,
			envProfile:                ctx.Profile.Name,
			"OPENCODE_CONFIG_CONTENT": string(content),
		}),
	}, nil
}
