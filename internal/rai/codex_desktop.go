package rai

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Desktop is a singleton; the CLI launcher's lifetime is not the app lifetime.
// Use explicit handoff/return rather than guessing when a window has closed.
func (a *App) temporaryCodex(profileName string, args []string) error {
	if len(args) != 0 {
		return errors.New("usage: rai codex --desktop")
	}
	path, err := codexConfigPath(a.Environ)
	if err != nil {
		return err
	}
	if _, err := os.Stat(codexJournalPath(path, true)); err == nil {
		return errors.New("a temporary desktop switch is pending; close Codex and run rai unconfigure codex to recover")
	} else if !os.IsNotExist(err) {
		return err
	}
	fmt.Fprintln(a.Stdout, "Temporary desktop connection uses your existing Codex configuration and history.")
	fmt.Fprintln(a.Stdout, "It also affects CLI launches using the same config. Fully quit Codex Desktop, then type ready to apply. Other input cancels.")
	scanner := bufio.NewScanner(a.Stdin)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return err
		}
		return errors.New("interactive confirmation required; no configuration changed")
	}
	if strings.TrimSpace(scanner.Text()) != "ready" {
		return nil
	}
	if err := a.configureCodexMode(profileName, []string{"codex", "-y"}, true); err != nil {
		return err
	}
	fmt.Fprintln(a.Stdout, "Open Codex Desktop from your usual shortcut and start a new chat. Keep this terminal open.")
	fmt.Fprintln(a.Stdout, "When finished, fully quit Codex Desktop and type restore. If this terminal closes, run rai unconfigure codex to recover.")
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "restore" {
			if err := restoreCodexManaged(path, true); err != nil {
				return err
			}
			fmt.Fprintln(a.Stdout, "Previous Codex connection restored. You can reopen Codex Desktop.")
			return nil
		}
		fmt.Fprintln(a.Stdout, "Type restore after fully quitting Codex Desktop.")
	}
	return errors.New("temporary configuration retained; close Codex Desktop and run rai unconfigure codex to restore")
}
