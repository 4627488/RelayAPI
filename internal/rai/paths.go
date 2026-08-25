package rai

import (
	"os"
	"path/filepath"
	"runtime"
)

func defaultHomeDir() (string, error) {
	if home := os.Getenv(envHome); home != "" {
		return filepath.Clean(home), nil
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			if err != nil {
				return "", err
			}
			return "", homeErr
		}
		if runtime.GOOS == "windows" {
			base = filepath.Join(home, "AppData", "Roaming")
		} else {
			base = filepath.Join(home, ".config")
		}
	}
	return filepath.Join(base, "rai"), nil
}
