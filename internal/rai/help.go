package rai

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

func isHelp(arg string) bool { return arg == "--help" || arg == "-h" }

func hasHelp(args []string) bool {
	for _, arg := range args {
		if isHelp(arg) {
			return true
		}
	}
	return false
}

func (a *App) executeHelp(args []string) error {
	switch args[0] {
	case "proxy":
		return a.proxyCommand(context.Background(), "", nil)
	case "auth":
		if len(args) > 2 {
			return errors.New("usage: rai help auth [command]")
		}
		if len(args) == 2 {
			return a.authHelp(args[1])
		}
		return a.authHelp("")
	case "model", "key", "device", "account", "usage", "server":
		return a.resourceHelp(args[0])
	default:
		return fmt.Errorf("unknown help topic %q", args[0])
	}
}

func (a *App) authHelp(command string) error {
	details := map[string]string{
		"login":   "rai auth login [--server <url>] [--scope inference|account] [--no-browser] [--with-token]\n\nAuthorize this device in your browser. Default scope: inference.\n--with-token reads a static inference API Key from stdin.\nAccount permission always requires a separate browser approval.",
		"status":  "rai auth status [--scope inference|account] [--profile <name>] [--json]\n\nCheck all saved profiles for the selected scope, or one named profile.\nInvalid authorization returns a nonzero exit status. Tokens are never displayed.",
		"switch":  "rai auth switch --profile <name> [--scope inference|account]\n\nSelect the active profile for the selected authorization scope.",
		"refresh": "rai auth refresh [--scope inference|account] [--no-browser]\n\nReauthorize the selected profile in your browser with the same permission.\nExpiring access tokens refresh automatically during normal use.",
		"logout":  "rai auth logout [--scope inference|account]\n\nRevoke the selected OAuth device session, then remove local credentials.\nFor a static API Key, remove the local credential only.",
		"token":   "rai auth token\n\nPrint the current inference access token or static API Key for a credential helper.\nRefresh tokens and account management tokens are never exported.",
	}
	if command != "" {
		detail, ok := details[command]
		if !ok {
			return fmt.Errorf("unknown auth command %q", command)
		}
		fmt.Fprintln(a.Stdout, "USAGE\n  "+detail+"\n\nGLOBAL FLAGS\n  --profile <name>  Select a deployment profile")
		return nil
	}
	fmt.Fprint(a.Stdout, `Authenticate with a RelayAPI server.

USAGE
  rai auth <command> [flags]

COMMANDS
  login      Authorize a device using a browser or an API Key from stdin
  status     Check saved authorizations and display their permissions
  switch     Select an active profile
  refresh    Reauthorize the current profile in a browser
  logout     Revoke authorization and remove the local credential
  token      Print the inference credential for a helper

PERMISSIONS
  --scope inference  Model access (default)
  --scope account    Manage your Keys, quota, usage and devices
  Each scope has its own approval, credential and active profile.

EXAMPLES
  rai auth login --server https://relay.example
  rai auth login --scope account
  rai auth status --scope account
  rai auth switch --profile work

LEARN MORE
  rai auth <command> --help
`)
	return nil
}

func (a *App) resourceHelp(resource string) error {
	help := map[string]string{
		"account": "rai account status\n  rai account quota\n\nAuthorize with rai auth login --scope account; manage authorization with rai auth --help.",
		"usage":   "rai usage [--days 1..90]",
		"server":  "rai server set <url>",
		"model":   "rai model list\n  rai model set <model|default|--auto>",
		"key":     "rai key list\n  rai key create --name <name> [--models <ids>] [--rpm <n>] [--daily-tokens <n>] [--aliases <alias=model,...>] [--show-secret]\n  rai key update <id> [--name <name>] [--enabled=true|false] [--models <ids>] [--rpm <n>] [--daily-tokens <n>] [--aliases <alias=model,...>]\n  rai key delete <id> --yes",
		"device":  "rai device list\n  rai device revoke <id> --yes",
	}
	fmt.Fprintf(a.Stdout, "USAGE\n  %s\n", help[resource])
	if resource == "key" || resource == "device" || resource == "model" {
		fmt.Fprintln(a.Stdout, "\nOUTPUT FLAGS\n  --json  Output JSON")
		if resource == "model" {
			fmt.Fprintln(a.Stdout, "          Available for model list only")
		}
	}
	if resource != "model" && resource != "server" {
		fmt.Fprintln(a.Stdout, "\nRequires: rai auth login --scope account")
		if resource == "account" || resource == "usage" {
			fmt.Fprintln(a.Stdout, "Output: JSON.")
		}
		if resource == "key" {
			fmt.Fprintln(a.Stdout, "New Key secrets require --show-secret.")
		}
	}
	return nil
}

func (a *App) modelCommand(ctx context.Context, profile string, args []string) error {
	args, asJSON, help, err := resourceOutputFlags(args)
	if err != nil {
		return err
	}
	if help || len(args) == 0 {
		return a.resourceHelp("model")
	}
	if len(args) == 1 && args[0] == "list" {
		return a.modelsWithOutput(ctx, profile, asJSON)
	}
	if len(args) == 2 && args[0] == "set" {
		if asJSON {
			return errors.New("--json is supported by rai model list only")
		}
		return a.use(profile, args[1:])
	}
	return fmt.Errorf("unknown model command %q; see rai model --help", strings.Join(args, " "))
}
