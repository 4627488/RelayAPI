package rai

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
)

func (a *App) unconfigureLegacyAgent(ctx context.Context, profileName string, args []string) error {
	if len(args) != 1 || (args[0] != "hermes" && args[0] != "prime-agent") {
		return errors.New("usage: rai unconfigure codex|hermes|prime-agent")
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	unlock, err := a.lockOAuthCredential(ctx, store, "client-config-"+args[0])
	if err != nil {
		return err
	}
	defer unlock()
	name := launchProviderID(LaunchContext{Profile: profile, RAIHome: store.Home})
	if args[0] == "hermes" {
		dir, e := clientHome(a.Environ, "HERMES_HOME", ".hermes")
		if e != nil {
			return e
		}
		err = mergeHermesProvider(filepath.Join(dir, "config.yaml"), name, nil)
	} else {
		dir, e := clientHome(a.Environ, "PRIME_AGENT_CODING_AGENT_DIR", ".prime/agent")
		if e != nil {
			return e
		}
		err = mergeClientProvider(filepath.Join(dir, "models.json"), name, nil)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Removed rai provider for %s from %s\n", profile.Name, args[0])
	return nil
}
