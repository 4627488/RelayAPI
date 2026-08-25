package rai

import (
	"encoding/json"
	"strings"
)

type OpenCodeAdapter struct{}

func (OpenCodeAdapter) Name() string { return "opencode" }

func (OpenCodeAdapter) Probe() (string, string, error) {
	path, err := lookPath("opencode")
	if err != nil {
		return "", "", err
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
	models := ctx.Models
	if len(models) == 0 {
		models = []string{ctx.Model}
	}
	openCodeModels := make(map[string]any, len(models))
	for _, model := range models {
		openCodeModels[model] = map[string]any{"name": model}
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
