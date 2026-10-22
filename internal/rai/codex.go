package rai

import (
	"encoding/json"
	"os/exec"
	"strconv"
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
	// Codex recursively merges even whole-table CLI overrides. Use an unused
	// provider so persisted credentials cannot mix with our auth command.
	providerID, err := codexRuntimeProvider(ctx.Environ, ctx.Args...)
	if err != nil {
		return Command{}, err
	}
	base := strings.TrimRight(ctx.APIBase, "/") + "/v1"
	rai := ctx.RAI
	if rai == "" {
		rai = selfExecutable()
	}
	profile := ctx.Profile
	if profile.ServerURL == "" {
		profile.ServerURL = ctx.APIBase
	}
	auth, err := codexAuth(profile, ctx.RAIHome, rai)
	if err != nil {
		return Command{}, err
	}
	authArgs, err := json.Marshal(auth["args"])
	if err != nil {
		return Command{}, err
	}
	capabilities := effectiveCodexCapabilities(ctx.Codex)
	overrides := []string{
		"model_provider=" + providerID,
		"model_providers." + providerID + ".name=RelayAPI",
		"model_providers." + providerID + ".base_url=" + quoteTOMLString(base),
		"model_providers." + providerID + ".wire_api=responses",
		"model_providers." + providerID + ".supports_websockets=" + strconv.FormatBool(capabilities.WebSockets),
		"model_providers." + providerID + ".supports_standalone_web_search=" + strconv.FormatBool(capabilities.StandaloneWebSearch),
		"model_providers." + providerID + ".auth.command=" + quoteTOMLString(rai),
		"model_providers." + providerID + ".auth.args=" + string(authArgs),
		"model_providers." + providerID + ".auth.timeout_ms=" + strconv.FormatInt(codexAuthTimeoutMS, 10),
		"model_providers." + providerID + ".auth.refresh_interval_ms=" + strconv.FormatInt(codexAuthRefreshMS, 10),
	}
	if capabilities.RemoteCompaction {
		overrides = append(overrides, "model_providers."+providerID+".capabilities.remote_compaction=\"v2\"")
	}
	if ctx.Model != "" {
		overrides = append(overrides, "model="+quoteTOMLString(ctx.Model))
	}
	if ctx.Profile.ReasoningEffort != "" {
		overrides = append(overrides, "model_reasoning_effort="+ctx.Profile.ReasoningEffort)
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
			envProfile: ctx.Profile.Name,
		}),
	}, nil
}

func quoteTOMLString(value string) string {
	// JSON string escapes are also valid TOML basic-string escapes.
	raw, _ := json.Marshal(value)
	return string(raw)
}

func probeVersion(path string) string {
	out, err := exec.Command(path, "--version").Output()
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(line)
}
