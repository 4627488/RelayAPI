package rai

import (
	"fmt"
	"os"
	"slices"
	"strings"
)

type Adapter interface {
	Name() string
	Install() string
	Probe() (string, string, error)
	Prepare(ctx LaunchContext) (Command, error)
}

type LaunchContext struct {
	Profile    Profile
	APIBase    string
	APIKey     string
	Model      string
	Models     []string
	Executable string
	Args       []string
	Environ    []string
	RAI        string
}

func Adapters() []Adapter {
	return []Adapter{
		ClaudeAdapter{},
		CodexAdapter{},
		EnvAdapter{Agent: "grok", BinaryName: "grok", InstallHint: "Install the Grok CLI from xAI and keep grok on PATH", Env: grokEnv, PassModel: true},
		EnvAdapter{Agent: "hermes", BinaryName: "hermes", InstallHint: "npm install -g @nousresearch/hermes-agent", Env: openAICompatibleEnv, PassModel: true},
		OpenCodeAdapter{},
		EnvAdapter{Agent: "pi", BinaryName: "pi", InstallHint: "npm install -g @mariozechner/pi-coding-agent", Env: openAICompatibleEnv, PassModel: true},
		EnvAdapter{Agent: "prime-agent", BinaryName: "prime-agent", InstallHint: "Install Prime Agent and keep prime-agent on PATH", Env: openAICompatibleEnv, PassModel: true},
	}
}

func AdapterByName(name string) (Adapter, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, adapter := range Adapters() {
		if adapter.Name() == name {
			return adapter, nil
		}
	}
	return nil, fmt.Errorf("unsupported agent %q", name)
}

func resolveLaunchModel(profile Profile, requested string, models []string) (string, error) {
	model := strings.TrimSpace(requested)
	if model == "" {
		model = strings.TrimSpace(profile.DefaultModel)
	}
	if model == "" && len(models) > 0 {
		model = models[0]
	}
	if model == "" {
		return "", fmt.Errorf("select a model with --model or rai use")
	}
	if len(models) > 0 && !slices.Contains(models, model) {
		return "", fmt.Errorf("model %q is not available on this API key", model)
	}
	return model, nil
}

func selfExecutable() string {
	path, err := os.Executable()
	if err != nil || path == "" {
		return "rai"
	}
	return path
}

func reasoningEffort(profile Profile) string {
	if profile.ReasoningEffort != "" {
		return profile.ReasoningEffort
	}
	return "high"
}

func openCodeProtocol(profile Profile) string {
	if profile.OpenCodeProtocol != "" {
		return profile.OpenCodeProtocol
	}
	return "responses"
}
