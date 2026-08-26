package rai

import (
	"encoding/json"
	"os/exec"
	"strings"
)

type CodexAdapter struct{}

func (CodexAdapter) Name() string { return "codex" }

func (CodexAdapter) Install() string { return "npm install -g @openai/codex" }

func (CodexAdapter) Probe() (string, string, error) {
	path, err := lookPath("codex")
	if err != nil {
		return "", "", missingBinary("codex", CodexAdapter{}.Install())
	}
	return path, probeVersion(path), nil
}

func (CodexAdapter) Prepare(ctx LaunchContext) (Command, error) {
	path := ctx.Executable
	if path == "" {
		var err error
		path, err = lookPath("codex")
		if err != nil {
			return Command{}, err
		}
	}
	base := strings.TrimRight(ctx.APIBase, "/") + "/v1"
	rai := ctx.RAI
	if rai == "" {
		rai = selfExecutable()
	}
	authArgs, err := json.Marshal([]string{"--profile", ctx.Profile.Name, "credential", "print"})
	if err != nil {
		return Command{}, err
	}
	overrides := []string{
		"model_provider=" + providerID,
		"model=" + quoteTOMLString(ctx.Model),
		"model_reasoning_effort=" + reasoningEffort(ctx.Profile),
		"model_providers." + providerID + ".name=RelayAPI",
		"model_providers." + providerID + ".base_url=" + quoteTOMLString(base),
		"model_providers." + providerID + ".wire_api=responses",
		"model_providers." + providerID + ".requires_openai_auth=false",
		"model_providers." + providerID + ".supports_websockets=true",
		"model_providers." + providerID + ".supports_standalone_web_search=true",
		"model_providers." + providerID + ".env_key=" + envAPIKey,
		"model_providers." + providerID + ".auth.command=" + quoteTOMLString(rai),
		"model_providers." + providerID + ".auth.args=" + string(authArgs),
		"features.apps=true",
	}
	args := make([]string, 0, len(overrides)*2+len(ctx.Args))
	for _, override := range overrides {
		args = append(args, "-c", override)
	}
	args = append(args, ctx.Args...)
	return Command{
		Path: path,
		Args: args,
		Env: mergeEnv(ctx.Environ, map[string]string{
			envAPIKey:  ctx.APIKey,
			envProfile: ctx.Profile.Name,
		}),
	}, nil
}

func quoteTOMLString(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func probeVersion(path string) string {
	out, err := exec.Command(path, "--version").Output()
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(line)
}
