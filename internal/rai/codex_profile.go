package rai

import (
	"errors"
	"path/filepath"
	"strings"
)

func codexTargetConfigPath(environ []string, name string) (string, error) {
	path, err := codexConfigPath(environ)
	if err != nil || name == "" {
		return path, err
	}
	if err := validateProfileName(name); err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), name+".config.toml"), nil
}

func parseCodexProfileFlag(args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	if len(args) != 2 || args[0] != "--codex-profile" {
		return "", errors.New("expected --codex-profile <name>")
	}
	if err := validateProfileName(args[1]); err != nil {
		return "", err
	}
	return args[1], nil
}

func selectedCodexProfile(args []string) string {
	for i, arg := range args {
		if arg == "--" {
			break
		}
		name, value, hasValue := strings.Cut(arg, "=")
		if name == "--profile" || name == "-p" {
			if hasValue {
				return value
			}
			if i+1 < len(args) {
				return args[i+1]
			}
		}
	}
	return ""
}
