package rai

import (
	"fmt"
	"runtime"
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
	// Grok Build uses this endpoint for both discovery and inference.
	env["GROK_MODELS_BASE_URL"] = strings.TrimRight(ctx.APIBase, "/") + "/v1"
	return env
}

func hasModelFlag(args []string) bool {
	return hasFlag(args, "--model", "-m")
}

func hasFlag(args []string, flags ...string) bool {
	for i := 0; i < len(args); i++ {
		name, _, _ := strings.Cut(args[i], "=")
		if contains(flags, name) {
			return true
		}
	}
	return false
}

func environmentValue(environ []string, name string) string {
	for i := len(environ) - 1; i >= 0; i-- {
		key, value, ok := strings.Cut(environ[i], "=")
		if ok && (key == name || runtime.GOOS == "windows" && strings.EqualFold(key, name)) {
			return value
		}
	}
	return ""
}

func v1APIBase(base string) string { return strings.TrimRight(base, "/") + "/v1" }

func nativeLaunchModel(args []string) (string, error) {
	model := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		name, value, inline := strings.Cut(args[i], "=")
		if name == "-p" || name == "--prompt" || name == "--system-prompt" {
			if !inline {
				i++
			}
			continue
		}
		if name != "--model" && name != "-m" {
			continue
		}
		if !inline {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s requires a value", name)
			}
			i++
			value = args[i]
		}
		model = value
	}
	return model, nil
}

func splitLaunchEffort(args []string) (string, []string, error) {
	effort := ""
	result := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			result = append(result, args[i:]...)
			break
		}
		name, value, inline := strings.Cut(args[i], "=")
		if name != "--reasoning-effort" {
			result = append(result, args[i])
			continue
		}
		if !inline {
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("%s requires a value", name)
			}
			i++
			value = args[i]
		}
		if !contains(supportedReasoningEfforts, value) {
			return "", nil, fmt.Errorf("unsupported reasoning effort %q", value)
		}
		effort = value
	}
	return effort, result, nil
}

func piThinkingLevel(effort string) string {
	if effort == "none" {
		return "off"
	}
	if effort == "ultra" {
		return "max"
	}
	return effort
}

func missingBinary(name, install string) error {
	if strings.TrimSpace(install) == "" {
		return fmt.Errorf("%s is not on PATH", name)
	}
	return fmt.Errorf("%s is not on PATH\nInstall: %s", name, install)
}
