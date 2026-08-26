package rai

import (
	"fmt"
	"strings"
)

type EnvAdapter struct {
	Agent       string
	BinaryName  string
	InstallHint string
	Env         func(LaunchContext) map[string]string
	PassModel   bool
}

func (a EnvAdapter) Name() string { return a.Agent }

func (a EnvAdapter) Install() string { return a.InstallHint }

func (a EnvAdapter) Probe() (string, string, error) {
	path, err := lookPath(a.BinaryName)
	if err != nil {
		return "", "", missingBinary(a.BinaryName, a.InstallHint)
	}
	return path, probeVersion(path), nil
}

func (a EnvAdapter) Prepare(ctx LaunchContext) (Command, error) {
	path := ctx.Executable
	if path == "" {
		var err error
		path, err = lookPath(a.BinaryName)
		if err != nil {
			return Command{}, missingBinary(a.BinaryName, a.InstallHint)
		}
	}
	args := append([]string(nil), ctx.Args...)
	if a.PassModel && ctx.Model != "" && !hasModelFlag(args) {
		args = append([]string{"--model", ctx.Model}, args...)
	}
	env := map[string]string{}
	if a.Env != nil {
		env = a.Env(ctx)
	}
	return Command{Path: path, Args: args, Env: mergeEnv(ctx.Environ, env)}, nil
}

func openAICompatibleEnv(ctx LaunchContext) map[string]string {
	return map[string]string{
		envAPIKey:         ctx.APIKey,
		envProfile:        ctx.Profile.Name,
		"OPENAI_API_KEY":  ctx.APIKey,
		"OPENAI_BASE_URL": strings.TrimRight(ctx.APIBase, "/") + "/v1",
	}
}

func grokEnv(ctx LaunchContext) map[string]string {
	env := openAICompatibleEnv(ctx)
	env["XAI_API_KEY"] = ctx.APIKey
	env["XAI_BASE_URL"] = strings.TrimRight(ctx.APIBase, "/") + "/v1"
	return env
}

func hasModelFlag(args []string) bool {
	for i := 0; i < len(args); i++ {
		name, _, _ := strings.Cut(args[i], "=")
		if name == "--model" || name == "-m" {
			return true
		}
	}
	return false
}

func missingBinary(name, install string) error {
	if strings.TrimSpace(install) == "" {
		return fmt.Errorf("%s is not on PATH", name)
	}
	return fmt.Errorf("%s is not on PATH\nInstall: %s", name, install)
}
