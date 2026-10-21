package rai

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"sort"
)

// Scope selects an existing server-enforced OAuth purpose. It never combines
// account management credentials with credentials handed to an agent.
func (a *App) authCommand(ctx context.Context, profileName string, args []string) error {
	if len(args) == 0 || (len(args) == 1 && isHelp(args[0])) {
		return a.authHelp("")
	}
	command := args[0]
	switch command {
	case "login", "logout", "status", "switch", "refresh", "token":
	default:
		return fmt.Errorf("unknown auth command %q; see rai auth --help", command)
	}
	for _, arg := range args[1:] {
		if isHelp(arg) {
			return a.authHelp(command)
		}
	}
	f := flag.NewFlagSet("rai auth "+command, flag.ContinueOnError)
	f.SetOutput(a.Stderr)
	scope := f.String("scope", "inference", "authorization: inference or account")
	server := f.String("server", "", "RelayAPI HTTPS URL")
	noBrowser := f.Bool("no-browser", false, "print the approval URL without opening a browser")
	withToken := f.Bool("with-token", false, "read an inference API Key from stdin")
	asJSON := f.Bool("json", false, "output authentication status as JSON")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return fmt.Errorf("unexpected auth argument %q", f.Arg(0))
	}
	if *scope != "inference" && *scope != "account" {
		return errors.New("--scope must be inference or account; authorize each separately")
	}
	var invalid string
	f.Visit(func(v *flag.Flag) {
		allowed := v.Name == "scope" || (command == "login" && (v.Name == "server" || v.Name == "no-browser" || v.Name == "with-token")) || (command == "refresh" && v.Name == "no-browser") || (command == "status" && v.Name == "json")
		if !allowed {
			invalid = v.Name
		}
	})
	if invalid != "" {
		return fmt.Errorf("--%s is not supported by rai auth %s", invalid, command)
	}
	if *scope == "account" && *withToken {
		return errors.New("account permission requires browser approval; --with-token supports inference only")
	}
	if command == "token" && *scope == "account" {
		return errors.New("account management tokens cannot be exported; use rai key, rai usage or rai device")
	}
	if command == "login" {
		loginArgs := []string{}
		if *server != "" {
			loginArgs = append(loginArgs, "--server", *server)
		}
		if *noBrowser {
			loginArgs = append(loginArgs, "--no-browser")
		}
		if *scope == "account" {
			return a.accountLoginWithOutput(ctx, profileName, loginArgs, a.accountAuthorizationOutput)
		}
		if *withToken {
			loginArgs = append(loginArgs, "--api-key-stdin")
		}
		return a.login(ctx, profileName, loginArgs)
	}
	s, err := a.store()
	if *scope == "account" {
		s, err = a.accountStore()
	}
	if err != nil {
		return err
	}
	if command == "status" {
		return a.authStatus(ctx, s, profileName, *scope, *asJSON)
	}
	if command == "switch" {
		if profileName == "" {
			return errors.New("select a profile with rai auth switch --profile <name> [--scope account]")
		}
		profile, err := s.ResolveProfile(profileName)
		if err != nil {
			return err
		}
		// Check the credential before persisting an active profile.
		name := profileCredentialName(profile)
		if *scope == "account" {
			name = managementCredentialName(profile.Name)
		}
		if _, err := a.oauthAccessToken(ctx, s, profile, name, *scope); err != nil {
			return err
		}
		if err := s.SetActive(profile.Name); err != nil {
			return err
		}
		a.terminal(a.Stdout).message("success", "Switched %s authorization to profile %s", *scope, profile.Name)
		return nil
	}
	profile, err := s.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	switch command {
	case "logout":
		if *scope == "account" {
			return a.manageWithOutput(ctx, profile.Name, []string{"account", "logout"}, func(any) error {
				a.terminal(a.Stdout).message("success", "Logged out account authorization for profile %s", profile.Name)
				return nil
			})
		}
		return a.logout(ctx, profile.Name, nil)
	case "token":
		return a.credential(ctx, profile.Name, []string{"print"})
	case "refresh":
		loginArgs := []string{"--server", profile.ServerURL}
		if *noBrowser {
			loginArgs = append(loginArgs, "--no-browser")
		}
		if *scope == "account" {
			return a.accountLoginWithOutput(ctx, profile.Name, loginArgs, a.accountAuthorizationOutput)
		}
		if profile.AuthMethod != "oauth" {
			return errors.New("API Key permissions cannot be refreshed; run rai auth login for browser authorization")
		}
		return a.login(ctx, profile.Name, loginArgs)
	}
	return nil
}

func (a *App) accountAuthorizationOutput(any) error {
	a.terminal(a.Stdout).message("success", "Authorized account management")
	fmt.Fprintln(a.Stdout, "Scope: account (Keys, quota, usage and devices)\nNext: rai key list | rai device list")
	return nil
}

type authStatusEntry struct {
	Profile         string `json:"profile"`
	Server          string `json:"server"`
	Scope           string `json:"scope"`
	Active          bool   `json:"active"`
	Authentication  string `json:"authentication"`
	CredentialStore string `json:"credential_store"`
	Valid           bool   `json:"valid"`
	Error           string `json:"error,omitempty"`
}

func (a *App) authStatus(ctx context.Context, s Store, selected, scope string, asJSON bool) error {
	cfg, err := s.Load()
	if err != nil {
		return err
	}
	names := make([]string, 0, len(cfg.Profiles))
	if selected != "" {
		if _, err := s.ResolveProfile(selected); err != nil {
			return err
		}
		names = append(names, selected)
	} else {
		for name := range cfg.Profiles {
			names = append(names, name)
		}
		sort.Strings(names)
	}
	if len(names) == 0 {
		return fmt.Errorf("no %s authorization; run rai auth login --scope %s --server <url>", scope, scope)
	}
	entries := make([]authStatusEntry, 0, len(names))
	failed := false
	for _, name := range names {
		profile := cfg.Profiles[name]
		method, credential := "api_key", profileCredentialName(profile)
		if profile.AuthMethod == "oauth" || scope == "account" {
			method = "oauth"
		}
		if scope == "account" {
			credential = managementCredentialName(name)
		}
		token, checkErr := a.oauthAccessToken(ctx, s, profile, credential, scope)
		if checkErr == nil {
			if scope == "account" {
				var session any
				checkErr = a.Gateway.managementRequest(ctx, profile.ServerURL, token, http.MethodGet, "session", nil, &session)
			} else {
				_, checkErr = a.Gateway.Session(ctx, profile.ServerURL, token)
			}
		}
		entry := authStatusEntry{Profile: name, Server: profile.ServerURL, Scope: scope, Active: cfg.ActiveProfile == name, Authentication: method, CredentialStore: profile.CredentialBackend, Valid: checkErr == nil}
		if checkErr != nil {
			failed = true
			// Do not include remote bodies or credentials in status diagnostics.
			entry.Error = "authorization check failed; run rai auth login --scope " + scope + " --profile " + name
		}
		entries = append(entries, entry)
	}
	if asJSON {
		if err := a.printManagementJSON(entries); err != nil {
			return err
		}
	} else {
		ui := a.terminal(a.Stdout)
		for _, entry := range entries {
			ui.heading(terminalText(entry.Server))
			ui.field("Profile", entry.Profile)
			ui.field("Active", fmt.Sprint(entry.Active))
			ui.field("Authentication", entry.Authentication)
			ui.field("Scope", entry.Scope)
			ui.field("Credential store", entry.CredentialStore)
			ui.field("Valid", fmt.Sprint(entry.Valid))
			if entry.Error != "" {
				ui.message("error", "%s", entry.Error)
			}
		}
	}
	if failed {
		return errors.New("one or more authorizations are invalid; see rai auth status")
	}
	return nil
}
