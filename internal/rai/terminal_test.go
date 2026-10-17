package rai

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestTerminalDecorationsNeverLeakIntoRedirectedOrJSONOutput(t *testing.T) {
	var out bytes.Buffer
	app := App{Stdout: &out, Environ: []string{"TERM=xterm-256color"}}
	ui := app.terminal(app.Stdout)
	ui.message("success", "Signed in")
	ui.field("Profile", "work")
	p := ui.progress("Downloading rai")
	p.update(5, 10)
	p.clear()
	if got := out.String(); got != "Signed in\nProfile: work\n" {
		t.Fatalf("redirected output was decorated: %q", got)
	}
	out.Reset()
	if err := app.printManagementJSON(map[string]any{"name": "work", "enabled": true}); err != nil {
		t.Fatal(err)
	}
	if !json.Valid(out.Bytes()) || strings.ContainsAny(out.String(), "\x1b\r") {
		t.Fatalf("management JSON was decorated: %q", out.String())
	}
}

func TestTerminalMessagesSanitizeRemoteControlsAndRespectColorDisabled(t *testing.T) {
	var out bytes.Buffer
	ui := terminalUI{out: &out, rich: true, color: false}
	ui.message("warning", "Server %s", "bad\x1b[2J\r\nname")
	ui.field("Profile", "work")
	if strings.ContainsAny(out.String(), "\x1b\r") || strings.Count(out.String(), "\n") != 2 || !strings.HasPrefix(out.String(), "! Server ") {
		t.Fatalf("untrusted controls or colors reached the terminal: %q", out.String())
	}
	ui.color = true
	out.Reset()
	ui.message("success", "Saved")
	if !strings.Contains(out.String(), "\x1b[32m✓\x1b[0m Saved") {
		t.Fatalf("missing semantic status: %q", out.String())
	}
}
