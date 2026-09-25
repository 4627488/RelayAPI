package rai

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// Other Codex settings remain in Codex's native configuration. Never copy
// credentials, provider routing, or permission policies into a rai profile.
type codexPreferences struct {
	Model     string `toml:"model"`
	Reasoning string `toml:"model_reasoning_effort"`
	modified  time.Time
}

func codexConfigPath(environ []string) (string, error) {
	home := ""
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(key, "CODEX_HOME") {
			home = value
		}
	}
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(userHome, ".codex")
	}
	return filepath.Join(home, "config.toml"), nil
}

func readCodexPreferences(environ []string) (codexPreferences, error) {
	path, err := codexConfigPath(environ)
	if err != nil {
		return codexPreferences{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return codexPreferences{}, nil
	}
	if err != nil {
		return codexPreferences{}, err
	}
	var preferences codexPreferences
	err = toml.Unmarshal(raw, &preferences)
	if info, statErr := os.Stat(path); statErr == nil {
		preferences.modified = info.ModTime()
	}
	return preferences, err
}

func applyCodexPreferences(profile *Profile, preferences codexPreferences, models []string) error {
	if preferences.Model != "" && !slices.Contains(models, preferences.Model) {
		return fmt.Errorf("Codex model %q is not available on this API key; run rai models", preferences.Model)
	}
	profile.DefaultModel = preferences.Model
	profile.FollowSiteDefault = false
	profile.ReasoningEffort = preferences.Reasoning
	return validateProfile(*profile)
}

func (a *App) syncCodex(ctx context.Context, profileName string) error {
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	preferences, err := readCodexPreferences(a.Environ)
	if err != nil {
		return fmt.Errorf("read Codex settings: %w", err)
	}
	key, err := store.Credential(profile.Name)
	if err != nil {
		return err
	}
	session, err := a.Gateway.Session(ctx, profile.ServerURL, key)
	if err != nil {
		return err
	}
	if err := applyCodexPreferences(&profile, preferences, session.Models); err != nil {
		return err
	}
	if err := store.PutProfile(profile); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Saved Codex preferences to rai profile %s: %s\n", profile.Name, modelLabel(profile.DefaultModel))
	return nil
}

func (a *App) saveChangedCodexPreferences(store Store, name string, before codexPreferences, models []string) {
	after, err := readCodexPreferences(a.Environ)
	if err == nil && after == before {
		return
	}
	if err == nil {
		var profile Profile
		profile, err = store.ResolveProfile(name)
		if err == nil {
			// Only import the preferences actually changed during this launch.
			// A reasoning-only edit must not replace a rai-specific model with
			// an unrelated model from the user's global Codex configuration.
			preferences := codexPreferences{Model: profile.DefaultModel, Reasoning: profile.ReasoningEffort}
			// Re-selecting the values already present in Codex's config still
			// counts as a saved selection when rai started with different overrides.
			if after.Model == before.Model && after.Reasoning == before.Reasoning && after.modified != before.modified {
				preferences = after
			}
			if after.Model != before.Model {
				preferences.Model = after.Model
				// Model and effort are one selection in Codex's model picker.
				preferences.Reasoning = after.Reasoning
			}
			if after.Reasoning != before.Reasoning {
				preferences.Reasoning = after.Reasoning
			}
			err = applyCodexPreferences(&profile, preferences, models)
		}
		if err == nil {
			err = store.PutProfile(profile)
		}
	}
	if err != nil {
		fmt.Fprintf(a.Stderr, "Could not save Codex preferences to rai: %s\n", redact(err.Error()))
		return
	}
	fmt.Fprintf(a.Stderr, "Saved Codex model and reasoning preferences to rai profile %s.\n", name)
}
