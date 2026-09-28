package rai

import (
	"bufio"
	"bytes"
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

func codexRuntimeProvider(environ []string) (string, error) {
	path, err := codexConfigPath(environ)
	if err != nil {
		return "", err
	}
	_, document, err := loadCodexConfig(path)
	if err != nil {
		return "", err
	}
	providers, _ := document["model_providers"].(map[string]any)
	name := "relayapi_rai"
	for i := 2; ; i++ {
		if _, exists := providers[name]; !exists {
			return name, nil
		}
		name = fmt.Sprintf("relayapi_rai_%d", i)
	}
}

func (a *App) configureCodex(profileName string, args []string) error {
	return a.configureCodexMode(profileName, args, false)
}

func (a *App) configureCodexMode(profileName string, args []string, temporary bool) error {
	if len(args) == 0 || args[0] != "codex" {
		return errors.New("usage: rai configure codex [-y|--yes]")
	}
	yes := false
	for _, arg := range args[1:] {
		switch arg {
		case "-y", "--yes":
			yes = true
		default:
			return fmt.Errorf("unknown configure argument %q", arg)
		}
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	_, err = store.Credential(profile.Name)
	if err != nil {
		return err
	}
	path, err := codexConfigPath(a.Environ)
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
	updated, err := mergeCodexConfig(document, profile, auth)
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
	fmt.Fprintf(a.Stdout, "Saved %s. Restart Codex Desktop and create a new chat to use this provider.\nExisting chats may keep their provider; rai unconfigure codex restores managed settings.\n", path)
	return nil
}

func mergeCodexConfig(document map[string]any, profile Profile, auth map[string]any) ([]byte, error) {
	providers, err := codexTable(document, "model_providers")
	if err != nil {
		return nil, err
	}
	provider, err := codexTable(providers, providerID)
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
	provider["supports_websockets"] = true
	provider["supports_standalone_web_search"] = true
	provider["auth"] = auth
	document["model_provider"] = providerID
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
