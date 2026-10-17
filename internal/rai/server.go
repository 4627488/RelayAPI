package rai

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// loginTarget reuses profile identity as well as its server when no profile was
// requested. Model and account credentials remain in their separate stores.
func (a *App) loginTarget(explicit, name string, account bool) (string, string, error) {
	root, err := a.store()
	if err != nil {
		return "", "", err
	}
	primary := root
	other, err := a.accountStore()
	if err != nil {
		return "", "", err
	}
	if account {
		primary, other = other, root
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.TrimSpace(os.Getenv(envProfile))
	}
	cfg, err := primary.Load()
	if err != nil {
		return "", "", err
	}
	otherCfg, err := other.Load()
	if err != nil {
		return "", "", err
	}
	if name == "" {
		name = cfg.ActiveProfile
	}
	if name == "" {
		name = otherCfg.ActiveProfile
	}
	if name == "" {
		name = "default"
	}
	if err := validateProfileName(name); err != nil {
		return "", "", err
	}
	server := strings.TrimSpace(explicit)
	if server == "" {
		server = strings.TrimSpace(os.Getenv(envServer))
	}
	if server == "" {
		server = cfg.Profiles[name].ServerURL
	}
	if server == "" {
		server = otherCfg.Profiles[name].ServerURL
	}
	if server == "" {
		rootCfg := cfg
		if account {
			rootCfg = otherCfg
		}
		server = rootCfg.DefaultServer
	}
	if server == "" {
		return "", "", errors.New("no server is configured; use --server <url> or rai server set <url>")
	}
	server, err = normalizeServerURL(server)
	return server, name, err
}

func (a *App) serverCommand(args []string) error {
	if len(args) != 2 || args[0] != "set" {
		return errors.New("usage: rai server set <url>")
	}
	server, err := managementServer(args[1])
	if err != nil {
		return err
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	cfg, err := store.Load()
	if err != nil {
		return err
	}
	cfg.DefaultServer = server
	if err := store.Save(cfg); err != nil {
		return err
	}
	fmt.Fprintln(a.Stdout, "Default server: "+server)
	return nil
}
