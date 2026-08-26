package rai

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func openBrowser(rawURL string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open browser: %w", err)
	}
	return nil
}

func deviceName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "rai"
	}
	return host
}
