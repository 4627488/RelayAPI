package rai

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

func loadCodexConfig(path string) ([]byte, map[string]any, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, map[string]any{}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	document := map[string]any{}
	if err := toml.Unmarshal(raw, &document); err != nil {
		// Parser diagnostics can include a line containing a secret.
		return nil, nil, errors.New("invalid Codex config.toml; fix its TOML syntax before continuing")
	}
	return raw, document, nil
}

func codexRuntimeProvider(environ []string, args ...string) (string, error) {
	path, err := codexConfigPath(environ)
	if err != nil {
		return "", err
	}
	_, document, err := loadCodexConfig(path)
	if err != nil {
		return "", err
	}
	providers, _ := document["model_providers"].(map[string]any)
	occupied := map[string]bool{}
	for name := range providers {
		occupied[name] = true
	}
	if selected := selectedCodexProfile(args); selected != "" {
		path, err := codexTargetConfigPath(environ, selected)
		if err != nil {
			return "", err
		}
		_, doc, err := loadCodexConfig(path)
		if err != nil {
			return "", err
		}
		if extra, ok := doc["model_providers"].(map[string]any); ok {
			for name := range extra {
				occupied[name] = true
			}
		}
	}
	name := "relayapi_rai"
	for i := 2; ; i++ {
		if !occupied[name] {
			return name, nil
		}
		name = fmt.Sprintf("relayapi_rai_%d", i)
	}
}

func (a *App) configureCodex(ctx context.Context, profileName string, args []string) error {
	return a.configureCodexMode(ctx, profileName, args, false)
}

func (a *App) configureCodexMode(ctx context.Context, profileName string, args []string, temporary bool) error {
	if len(args) == 0 || args[0] != "codex" {
		return errors.New("usage: rai configure codex [-y|--yes]")
	}
	yes := false
	server := ""
	noBrowser := false
	nativeProfile := ""
	for i := 1; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "-y", "--yes":
			yes = true
		case "--server":
			if i+1 >= len(args) {
				return errors.New("--server requires a URL")
			}
			i++
			server = args[i]
		case "--no-browser":
			noBrowser = true
		case "--codex-profile":
			if temporary {
				return errors.New("--codex-profile is not supported for temporary Desktop switching")
			}
			if i+1 >= len(args) {
				return errors.New("--codex-profile requires a name")
			}
			i++
			nativeProfile = args[i]
			if err := validateProfileName(nativeProfile); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unknown configure argument %q", arg)
		}
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil || server != "" {
		if server == "" {
			err = a.ensureLogin(ctx, profileName, noBrowser)
		} else {
			loginArgs := []string{"--server", server}
			if noBrowser {
				loginArgs = append(loginArgs, "--no-browser")
			}
			err = a.login(ctx, profileName, loginArgs)
		}
		if err == nil {
			profile, err = store.ResolveProfile(profileName)
		}
	}
	if err != nil {
		return err
	}
	secret, err := a.profileCredential(ctx, store, profile)
	if errors.Is(err, errOAuthLoginRequired) {
		profile, secret, err = a.reauthorizeProfile(ctx, store, profile, noBrowser)
	}
	if err != nil {
		return err
	}
	capabilities := profile.Codex
	if strings.HasPrefix(secret, "rai_at_") {
		var session Session
		session, err = a.Gateway.Session(ctx, profile.ServerURL, secret)
		capabilities = session.Codex
		if errors.Is(err, errOAuthLoginRequired) {
			profile, secret, err = a.reauthorizeProfile(ctx, store, profile, noBrowser)
			if err == nil {
				session, err = a.Gateway.Session(ctx, profile.ServerURL, secret)
				capabilities = session.Codex
			}
		}
		if err != nil {
			return err
		}
	}
	path, err := codexTargetConfigPath(a.Environ, nativeProfile)
	if err != nil {
		return err
	}
	if _, err := os.Stat(codexJournalPath(path, true)); err == nil {
		return errors.New("temporary desktop configuration is pending; close Codex and run rai unconfigure codex first")
	} else if !os.IsNotExist(err) {
		return err
	}
	original, document, err := loadCodexConfig(path)
	if err != nil {
		return err
	}
	auth, err := codexAuth(profile, store.Home, a.Self)
	if err != nil {
		return err
	}
	id := providerID
	if nativeProfile != "" {
		id, err = codexRuntimeProvider(a.Environ)
		if err != nil {
			return err
		}
	}
	updated, err := mergeCodexProvider(document, profile, auth, id, capabilities)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Write profile %s to %s\nThis selects RelayAPI using the rai credential helper; no new API key is written to Codex config.\nExisting settings are merged; TOML formatting and comments are rewritten.\n", profile.Name, path)
	if original != nil {
		fmt.Fprintf(a.Stdout, "Original file will be backed up to %s.rai.bak\n", path)
	}
	if !yes {
		fmt.Fprint(a.Stdout, "Continue? [y/N] ")
		scanner := bufio.NewScanner(a.Stdin)
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return err
			}
			return errors.New("confirmation required; use -y for non-interactive configuration")
		}
		answer := strings.TrimSpace(scanner.Text())
		if !strings.EqualFold(answer, "y") && !strings.EqualFold(answer, "yes") {
			fmt.Fprintln(a.Stdout, "Cancelled; Codex configuration was not changed.")
			return nil
		}
	}
	// Do not overwrite an edit made while the confirmation was open.
	current, _, err := loadCodexConfig(path)
	if err != nil {
		return err
	}
	if (current == nil) != (original == nil) || !bytes.Equal(current, original) {
		return errors.New("Codex configuration changed during confirmation; run configure again")
	}
	if original != nil {
		if err := writeFileAtomic(path+".rai.bak", original, 0o600); err != nil {
			return fmt.Errorf("back up Codex configuration: %w", err)
		}
	}
	if err := saveCodexManaged(path, original, updated, temporary); err != nil {
		return err
	}
	if nativeProfile != "" {
		a.terminal(a.Stdout).message("success", "Saved %s. Start Codex with: codex --profile %s", path, nativeProfile)
		return nil
	}
	a.terminal(a.Stdout).message("success", "Saved %s. Restart Codex Desktop and create a new chat to use this provider.", path)
	fmt.Fprintln(a.Stdout, "Existing chats may keep their provider; rai unconfigure codex restores managed settings.")
	return nil
}

func mergeCodexConfig(document map[string]any, profile Profile, auth map[string]any, advertised ...*CodexCapabilities) ([]byte, error) {
	return mergeCodexProvider(document, profile, auth, providerID, advertised...)
}

func mergeCodexProvider(document map[string]any, profile Profile, auth map[string]any, id string, advertised ...*CodexCapabilities) ([]byte, error) {
	providers, err := codexTable(document, "model_providers")
	if err != nil {
		return nil, err
	}
	provider, err := codexTable(providers, id)
	if err != nil {
		return nil, err
	}
	// Command auth must not coexist with static or OpenAI authentication.
	for _, field := range []string{"experimental_bearer_token", "env_key", "env_key_instructions", "requires_openai_auth"} {
		delete(provider, field)
	}
	// A saved Authorization header would override the selected credential.
	for _, field := range []string{"http_headers", "env_http_headers"} {
		if headers, ok := provider[field].(map[string]any); ok {
			for name := range headers {
				if strings.EqualFold(name, "Authorization") {
					delete(headers, name)
				}
			}
		}
	}
	provider["name"] = "RelayAPI"
	provider["base_url"] = strings.TrimRight(profile.ServerURL, "/") + "/v1"
	provider["wire_api"] = "responses"
	var capabilities *CodexCapabilities
	if len(advertised) > 0 {
		capabilities = advertised[0]
	}
	effective := effectiveCodexCapabilities(capabilities)
	provider["supports_websockets"] = effective.WebSockets
	provider["supports_standalone_web_search"] = effective.StandaloneWebSearch
	overrides, err := codexTable(provider, "capabilities")
	if err != nil {
		return nil, err
	}
	if effective.RemoteCompaction {
		overrides["remote_compaction"] = "v2"
	} else {
		delete(overrides, "remote_compaction")
	}
	if len(overrides) == 0 {
		delete(provider, "capabilities")
	}
	provider["auth"] = auth
	document["model_provider"] = id
	if profile.DefaultModel != "" {
		document["model"] = profile.DefaultModel
	}
	if profile.ReasoningEffort != "" {
		document["model_reasoning_effort"] = profile.ReasoningEffort
	}
	return toml.Marshal(document)
}

func codexTable(parent map[string]any, name string) (map[string]any, error) {
	if value, exists := parent[name]; exists {
		table, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("Codex configuration %s must be a table", name)
		}
		return table, nil
	}
	table := map[string]any{}
	parent[name] = table
	return table, nil
}
