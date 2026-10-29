package rai

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"strings"
)

type agentConfigureFlags struct {
	Server, Model, Effort string
	Yes, NoBrowser        bool
}

func parseAgentConfigureFlags(args []string) (agentConfigureFlags, error) {
	var flags agentConfigureFlags
	for i := 0; i < len(args); i++ {
		name, value, inline := strings.Cut(args[i], "=")
		switch name {
		case "-y", "--yes":
			if inline {
				return flags, errors.New("--yes does not take a value")
			}
			flags.Yes = true
		case "--no-browser":
			if inline {
				return flags, errors.New("--no-browser does not take a value")
			}
			flags.NoBrowser = true
		case "--server", "--model", "--reasoning-effort":
			if !inline {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
					return flags, fmt.Errorf("%s requires a value", name)
				}
				i++
				value = args[i]
			}
			if value == "" {
				return flags, fmt.Errorf("%s requires a value", name)
			}
			switch name {
			case "--server":
				flags.Server = value
			case "--model":
				flags.Model = value
			case "--reasoning-effort":
				if !contains(supportedReasoningEfforts, value) {
					return flags, fmt.Errorf("unsupported reasoning effort %q", value)
				}
				flags.Effort = value
			}
		default:
			return flags, fmt.Errorf("unknown configure argument %q", args[i])
		}
	}
	return flags, nil
}

func (a *App) configureAgent(ctx context.Context, profileName string, args []string) error {
	if len(args) == 0 || hasHelp(args) {
		fmt.Fprintln(a.Stdout, configureUsage())
		return nil
	}
	agent := args[0]
	if agent == "codex" {
		return a.configureCodex(ctx, profileName, args)
	}
	if !contains(configurableAgents, agent) {
		return fmt.Errorf("unsupported configure target %q; %s", agent, configureUsage())
	}
	flags, err := parseAgentConfigureFlags(args[1:])
	if err != nil {
		return err
	}
	// Parse every existing file before authorization or starting a background
	// service; malformed settings must never be replaced by defaults.
	files, err := loadAgentConfig(agent, a.Environ)
	if err != nil {
		return err
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil || flags.Server != "" {
		if flags.Server == "" {
			err = a.ensureLogin(ctx, profileName, flags.NoBrowser)
		} else {
			login := []string{"--server", flags.Server}
			if flags.NoBrowser {
				login = append(login, "--no-browser")
			}
			err = a.login(ctx, profileName, login)
		}
		if err != nil {
			return err
		}
		profile, err = store.ResolveProfile(profileName)
		if err != nil {
			return err
		}
	}
	secret, err := a.profileCredential(ctx, store, profile)
	if errors.Is(err, errOAuthLoginRequired) {
		profile, secret, err = a.reauthorizeProfile(ctx, store, profile, flags.NoBrowser)
	}
	if err != nil {
		return err
	}
	session, err := a.Gateway.Session(ctx, profile.ServerURL, secret)
	if errors.Is(err, errOAuthLoginRequired) {
		profile, secret, err = a.reauthorizeProfile(ctx, store, profile, flags.NoBrowser)
		if err == nil {
			session, err = a.Gateway.Session(ctx, profile.ServerURL, secret)
		}
	}
	if err != nil {
		return err
	}
	if flags.Model == "default" {
		flags.Model = ""
		profile.DefaultModel = ""
	}
	model, err := resolveLaunchModel(profile, flags.Model, session.Models, session.DefaultModel)
	if err != nil {
		return err
	}
	if !agentCapable(session.ModelInfo[model]) {
		return fmt.Errorf("model %q does not support agent tools", model)
	}
	if flags.Effort != "" {
		profile.ReasoningEffort = flags.Effort
	}
	launch := LaunchContext{Profile: profile, Model: model, Models: session.Models, ModelInfo: session.ModelInfo, RAI: a.Self, RAIHome: store.Home, Environ: a.Environ}
	// Validate the complete merge with a non-secret placeholder before asking
	// for confirmation. The actual local credential is minted only afterwards.
	launch.APIBase, launch.APIKey = "http://127.0.0.1:1", "rai_local_preview"
	if err := buildAgentConfig(agent, launch, files); err != nil {
		return err
	}
	for _, file := range files {
		if _, err := file.render(file.Document); err != nil {
			return err
		}
		fmt.Fprintf(a.Stdout, "Write rai profile %s to %s\n", profile.Name, file.Path)
	}
	fmt.Fprintln(a.Stdout, "This sets the default provider and model. Existing settings are merged; backups and recovery records are saved. Only a local proxy credential is written.")
	if agent == "grok" {
		fmt.Fprintln(a.Stdout, "TOML formatting and comments will be rewritten.")
	}
	if !flags.Yes {
		fmt.Fprint(a.Stdout, "Continue? [y/N] ")
		scanner := bufio.NewScanner(a.Stdin)
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return err
			}
			return errors.New("confirmation required; use -y for non-interactive configuration")
		}
		answer := strings.TrimSpace(scanner.Text())
		if !strings.EqualFold(answer, "y") && !strings.EqualFold(answer, "yes") {
			fmt.Fprintln(a.Stdout, "Cancelled; client configuration was not changed.")
			return nil
		}
	}
	unlock, err := a.lockOAuthCredential(ctx, store, "client-config-"+agent)
	if err != nil {
		return err
	}
	defer unlock()
	for _, file := range files {
		latest, err := configFileState(file.Path)
		if err != nil {
			return err
		}
		if !sameConfigBytes(latest, file.Raw) {
			return errors.New("client configuration changed during confirmation; run configure again")
		}
	}
	base, key, err := a.ensurePersistentProxy(ctx, store, profile)
	if err != nil {
		return err
	}
	launch.APIBase, launch.APIKey = base, key
	if err := buildAgentConfig(agent, launch, files); err != nil {
		return err
	}
	if err := saveClientConfig(agent, profile.Name, files); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Configured %s. Restart it and run %s directly. rai unconfigure %s restores managed settings.\n", agent, agent, agent)
	return nil
}

func (a *App) unconfigureAgent(ctx context.Context, profileName string, args []string) error {
	if len(args) == 0 || hasHelp(args) {
		fmt.Fprintln(a.Stdout, "Usage: rai unconfigure <codex|"+strings.Join(configurableAgents, "|")+">")
		return nil
	}
	if len(args) != 1 || !contains(configurableAgents, args[0]) {
		return errors.New("select a supported client with rai unconfigure <agent>")
	}
	agent := args[0]
	files, err := loadAgentConfig(agent, a.Environ)
	if err != nil {
		return err
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	unlock, err := a.lockOAuthCredential(ctx, store, "client-config-"+agent)
	if err != nil {
		return err
	}
	restored, err := restoreAgentConfig(agent, profileName, files)
	unlock()
	if err != nil {
		return err
	}
	if !restored && (agent == "hermes" || agent == "prime-agent") {
		return a.unconfigureLegacyAgent(ctx, profileName, args)
	}
	if restored {
		fmt.Fprintf(a.Stdout, "Restored rai-managed %s settings; user edits were retained.\n", agent)
	} else {
		fmt.Fprintf(a.Stdout, "No rai-managed %s configuration found.\n", agent)
	}
	return nil
}
