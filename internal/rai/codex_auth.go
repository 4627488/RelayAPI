package rai

import (
	"path/filepath"
)

// Bind the helper to a store and audience rather than the desktop's environment.
func codexAuth(profile Profile, home, executable string) (map[string]any, error) {
	if home == "" {
		var err error
		home, err = defaultHomeDir()
		if err != nil {
			return nil, err
		}
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	if executable == "" {
		executable = selfExecutable()
	}
	return map[string]any{
		"command":    executable,
		"args":       []string{"--profile", profile.Name, "credential", "print", "--home", home, "--server", profile.ServerURL},
		"timeout_ms": int64(5000), "refresh_interval_ms": int64(300000),
	}, nil
}
