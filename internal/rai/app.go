package rai

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type App struct {
	Args    []string
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
	Environ []string
	Home    string
	Gateway Gateway
	Run     Runner
	Now     func() time.Time
	Look    func(string) (string, error)
	Self    string
	OpenURL func(string) error
	Sleep   func(context.Context, time.Duration) error
}

func Main() int {
	app := App{
		Args:    os.Args[1:],
		Stdin:   os.Stdin,
		Stdout:  os.Stdout,
		Stderr:  os.Stderr,
		Environ: os.Environ(),
		Gateway: NewGateway(),
		Run:     DefaultRunner(),
		Now:     time.Now,
		Self:    selfExecutable(),
	}
	if err := app.Execute(context.Background()); err != nil {
		var exit ExitError
		if errors.As(err, &exit) {
			return exit.Code
		}
		fmt.Fprintf(os.Stderr, "rai: %s\n", redact(err.Error()))
		return 1
	}
	return 0
}

func (a *App) Execute(ctx context.Context) error {
	a.defaults()
	args, profileName, err := splitGlobalFlags(a.Args)
	if err != nil {
		return err
	}
	if len(args) == 0 {
		return a.usage()
	}
	switch args[0] {
	case "help", "-h", "--help":
		return a.usage()
	case "version", "--version":
		fmt.Fprintln(a.Stdout, "rai "+Version)
		return nil
	case "login":
		return a.login(ctx, profileName, args[1:])
	case "logout":
		return a.logout(profileName, args[1:])
	case "status":
		return a.status(ctx, profileName)
	case "models":
		return a.models(ctx, profileName)
	case "use":
		return a.use(profileName, args[1:])
	case "credential":
		return a.credential(profileName, args[1:])
	case "doctor":
		return a.doctor(ctx, profileName)
	case "update":
		return a.update(ctx)
	case "claude", "codex", "grok", "hermes", "opencode", "pi", "prime-agent":
		return a.launch(ctx, profileName, args[0], args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func (a *App) defaults() {
	if a.Stdin == nil {
		a.Stdin = os.Stdin
	}
	if a.Stdout == nil {
		a.Stdout = os.Stdout
	}
	if a.Stderr == nil {
		a.Stderr = os.Stderr
	}
	if a.Environ == nil {
		a.Environ = os.Environ()
	}
	if a.Run == nil {
		a.Run = DefaultRunner()
	}
	if a.Now == nil {
		a.Now = time.Now
	}
	if a.Gateway.HTTP == nil {
		a.Gateway = NewGateway()
	}
	if a.Look == nil {
		a.Look = lookPath
	}
	if a.Self == "" {
		a.Self = selfExecutable()
	}
	if a.OpenURL == nil {
		a.OpenURL = openBrowser
	}
	if a.Sleep == nil {
		a.Sleep = func(ctx context.Context, d time.Duration) error {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
}

func (a *App) store() (Store, error) {
	return OpenStore(a.Home)
}

func (a *App) usage() error {
	fmt.Fprint(a.Stdout, `rai — RelayAPI agent launcher

Usage:
  rai login --server <url> [--no-browser] [--profile name] [--model id]
  rai login --server <url> --api-key-stdin
  rai logout [--profile name]
  rai status
  rai models
  rai use <model>
  rai credential print
  rai doctor
  rai update
  rai claude [--model id] -- <claude args>
  rai codex [--model id] -- <codex args>
  rai grok [--model id] -- <grok args>
  rai hermes [--model id] -- <hermes args>
  rai opencode [--model id] -- <opencode args>
  rai pi [--model id] -- <pi args>
  rai prime-agent [--model id] -- <prime-agent args>

Global flags:
  --profile name    Select a named deployment profile
`)
	return nil
}

func splitGlobalFlags(args []string) ([]string, string, error) {
	var profile string
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			out = append(out, args[i:]...)
			break
		}
		name, value, hasValue := strings.Cut(arg, "=")
		switch name {
		case "--profile":
			if !hasValue {
				if i+1 >= len(args) {
					return nil, "", errors.New("--profile requires a name")
				}
				i++
				value = args[i]
			}
			if err := validateProfileName(value); err != nil {
				return nil, "", err
			}
			profile = value
		default:
			out = append(out, arg)
		}
	}
	return out, profile, nil
}

func (a *App) login(ctx context.Context, profileName string, args []string) error {
	flags, err := parseLoginFlags(args)
	if err != nil {
		return err
	}
	if profileName == "" {
		profileName = flags.Profile
	}
	if profileName == "" {
		profileName = "default"
	}
	if err := validateProfileName(profileName); err != nil {
		return err
	}
	server := flags.Server
	if server == "" {
		server = strings.TrimSpace(os.Getenv(envServer))
	}
	server, err = normalizeServerURL(server)
	if err != nil {
		return err
	}
	var key string
	if flags.APIKeyStdin {
		key, err = a.readAPIKey(true)
		if err != nil {
			return err
		}
	} else {
		key, err = a.loginWithBrowser(ctx, server, flags.NoBrowser)
		if err != nil {
			return err
		}
	}
	return a.finishLogin(ctx, profileName, server, key, flags)
}

func (a *App) loginWithBrowser(ctx context.Context, server string, noBrowser bool) (string, error) {
	verifier, err := newPKCEVerifier()
	if err != nil {
		return "", err
	}
	auth, err := a.Gateway.StartAuthorization(ctx, server, deviceName(), pkceChallengeS256(verifier))
	if err != nil {
		return "", err
	}
	fmt.Fprintf(a.Stdout, "Open this URL to approve rai:\n%s\n", auth.VerificationURI)
	if !noBrowser {
		if err := a.OpenURL(auth.VerificationURI); err != nil {
			fmt.Fprintf(a.Stderr, "browser: %s\n", err.Error())
		}
	}
	deadline := a.Now().Add(time.Duration(auth.ExpiresIn) * time.Second)
	if auth.ExpiresIn <= 0 {
		deadline = a.Now().Add(10 * time.Minute)
	}
	interval := time.Duration(auth.Interval) * time.Second
	if interval < time.Second {
		interval = 3 * time.Second
	}
	for {
		if !a.Now().Before(deadline) {
			return "", errors.New("authorization expired")
		}
		token, err := a.Gateway.ExchangeToken(ctx, server, auth.ID, verifier)
		if err == nil {
			return token.APIKey, nil
		}
		var tokenErr tokenError
		if errors.As(err, &tokenErr) && tokenErr.Code == "authorization_pending" {
			if err := a.Sleep(ctx, interval); err != nil {
				return "", err
			}
			continue
		}
		return "", err
	}
}

func (a *App) finishLogin(ctx context.Context, profileName, server, key string, flags loginFlags) error {
	discovery, err := a.Gateway.Discover(ctx, server)
	if err != nil {
		return err
	}
	apiBase := discovery.APIBase
	if apiBase == "" {
		apiBase = server
	}
	session, err := a.Gateway.Session(ctx, apiBase, key)
	if err != nil {
		return err
	}
	model := strings.TrimSpace(flags.Model)
	if model == "" {
		model = session.DefaultModel
	}
	if model == "" && len(session.Models) > 0 {
		model = session.Models[0]
	}
	if len(session.Models) > 0 && model != "" && !contains(session.Models, model) {
		return fmt.Errorf("model %q is not available on this API key", model)
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	backend, err := store.PutCredential(profileName, key)
	if err != nil {
		return err
	}
	display := session.Name
	if display == "" {
		display = discovery.Name
	}
	if display == "" {
		display = "RelayAPI"
	}
	profile := Profile{
		Name:              profileName,
		ServerURL:         apiBase,
		DisplayName:       display,
		DefaultModel:      model,
		ReasoningEffort:   flags.ReasoningEffort,
		OpenCodeProtocol:  flags.OpenCodeProtocol,
		CredentialBackend: backend,
		LastRefresh:       a.Now().UTC(),
	}
	if profile.ReasoningEffort == "" {
		profile.ReasoningEffort = "high"
	}
	if profile.OpenCodeProtocol == "" {
		profile.OpenCodeProtocol = "responses"
	}
	if err := store.PutProfile(profile); err != nil {
		return err
	}
	if err := store.SetActive(profileName); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Signed in to %s as profile %s\n", apiBase, profileName)
	fmt.Fprintf(a.Stdout, "Default model: %s\n", model)
	fmt.Fprintf(a.Stdout, "Credential store: %s\n", backend)
	return nil
}

type loginFlags struct {
	Server           string
	Profile          string
	Model            string
	ReasoningEffort  string
	OpenCodeProtocol string
	APIKeyStdin      bool
	NoBrowser        bool
}

func parseLoginFlags(args []string) (loginFlags, error) {
	var flags loginFlags
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, hasValue := strings.Cut(arg, "=")
		need := func() (string, error) {
			if hasValue {
				return value, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s requires a value", name)
			}
			i++
			return args[i], nil
		}
		switch name {
		case "--server":
			var err error
			flags.Server, err = need()
			if err != nil {
				return flags, err
			}
		case "--profile":
			var err error
			flags.Profile, err = need()
			if err != nil {
				return flags, err
			}
		case "--model":
			var err error
			flags.Model, err = need()
			if err != nil {
				return flags, err
			}
		case "--reasoning-effort":
			var err error
			flags.ReasoningEffort, err = need()
			if err != nil {
				return flags, err
			}
		case "--opencode-protocol":
			var err error
			flags.OpenCodeProtocol, err = need()
			if err != nil {
				return flags, err
			}
		case "--api-key-stdin":
			flags.APIKeyStdin = true
		case "--no-browser":
			flags.NoBrowser = true
		default:
			return flags, fmt.Errorf("unknown login flag %q", arg)
		}
	}
	if flags.Server == "" && strings.TrimSpace(os.Getenv(envServer)) == "" {
		return flags, errors.New("login requires --server or RAI_SERVER")
	}
	return flags, nil
}

func (a *App) readAPIKey(fromStdin bool) (string, error) {
	if !fromStdin {
		return "", errors.New("login requires --api-key-stdin")
	}
	scanner := bufio.NewScanner(a.Stdin)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", err
		}
		return "", errors.New("read API key from stdin")
	}
	key := strings.TrimSpace(scanner.Text())
	if key == "" {
		return "", errors.New("API key is empty")
	}
	return key, nil
}

func (a *App) logout(profileName string, args []string) error {
	if extra := flagsWithoutValues(args); len(extra) > 0 {
		return fmt.Errorf("unknown logout argument %q", extra[0])
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	if profileName == "" {
		cfg, err := store.Load()
		if err != nil {
			return err
		}
		profileName = cfg.ActiveProfile
	}
	if profileName == "" {
		return errors.New("no active profile to log out")
	}
	_ = store.DeleteCredential(profileName)
	if err := store.DeleteProfile(profileName); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Logged out profile %s\n", profileName)
	return nil
}

func (a *App) status(ctx context.Context, profileName string) error {
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	secret, err := store.Credential(profile.Name)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Profile: %s\n", profile.Name)
	fmt.Fprintf(a.Stdout, "Server: %s\n", profile.ServerURL)
	fmt.Fprintf(a.Stdout, "Display name: %s\n", profile.DisplayName)
	fmt.Fprintf(a.Stdout, "Default model: %s\n", profile.DefaultModel)
	fmt.Fprintf(a.Stdout, "Credential: %s (%s)\n", keyPrefix(secret), profile.CredentialBackend)
	if !profile.LastRefresh.IsZero() {
		fmt.Fprintf(a.Stdout, "Last refresh: %s\n", profile.LastRefresh.Format(time.RFC3339))
	}
	session, err := a.Gateway.Session(ctx, profile.ServerURL, secret)
	if err != nil {
		fmt.Fprintf(a.Stderr, "session: %s\n", redact(err.Error()))
		return nil
	}
	fmt.Fprintf(a.Stdout, "Available models: %d\n", len(session.Models))
	return nil
}

func (a *App) models(ctx context.Context, profileName string) error {
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	secret, err := store.Credential(profile.Name)
	if err != nil {
		return err
	}
	session, err := a.Gateway.Session(ctx, profile.ServerURL, secret)
	if err != nil {
		return err
	}
	for _, model := range session.Models {
		mark := " "
		if model == profile.DefaultModel {
			mark = "*"
		}
		fmt.Fprintf(a.Stdout, "%s %s\n", mark, model)
	}
	return nil
}

func (a *App) use(profileName string, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: rai use <model>")
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	profile.DefaultModel = strings.TrimSpace(args[0])
	if err := store.PutProfile(profile); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "Default model is now %s\n", profile.DefaultModel)
	return nil
}

func (a *App) credential(profileName string, args []string) error {
	if len(args) != 1 || args[0] != "print" {
		return errors.New("usage: rai credential print")
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	secret, err := store.Credential(profile.Name)
	if err != nil {
		return err
	}
	fmt.Fprintln(a.Stdout, secret)
	return nil
}

func (a *App) doctor(ctx context.Context, profileName string) error {
	store, err := a.store()
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "rai %s\n", Version)
	fmt.Fprintf(a.Stdout, "home: %s\n", store.Home)
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		fmt.Fprintf(a.Stdout, "profile: %s\n", err.Error())
		return nil
	}
	fmt.Fprintf(a.Stdout, "profile: %s\n", profile.Name)
	fmt.Fprintf(a.Stdout, "server: %s\n", profile.ServerURL)
	secret, err := store.Credential(profile.Name)
	if err != nil {
		fmt.Fprintf(a.Stdout, "credential: %s\n", err.Error())
	} else {
		fmt.Fprintf(a.Stdout, "credential: %s (%s)\n", keyPrefix(secret), profile.CredentialBackend)
		session, sessErr := a.Gateway.Session(ctx, profile.ServerURL, secret)
		if sessErr != nil {
			fmt.Fprintf(a.Stdout, "session: %s\n", redact(sessErr.Error()))
		} else {
			fmt.Fprintf(a.Stdout, "session: %d models, default %s\n", len(session.Models), session.DefaultModel)
		}
	}
	for _, adapter := range Adapters() {
		path, version, probeErr := adapter.Probe()
		if probeErr != nil {
			fmt.Fprintf(a.Stdout, "%s: %s\n", adapter.Name(), probeErr.Error())
			continue
		}
		if version == "" {
			version = filepath.Base(path)
		}
		fmt.Fprintf(a.Stdout, "%s: %s\n", adapter.Name(), version)
	}
	return nil
}

func (a *App) ensureLogin(ctx context.Context, profileName string) error {
	server := strings.TrimSpace(os.Getenv(envServer))
	if server == "" {
		return errors.New("no rai profile is configured; run rai login --server <url>")
	}
	args := []string{"--server", server}
	if profileName != "" {
		args = append(args, "--profile", profileName)
	}
	return a.login(ctx, profileName, args)
}

func (a *App) launch(ctx context.Context, profileName, agent string, args []string) error {
	model, passthrough, err := splitLaunchArgs(args)
	if err != nil {
		return err
	}
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		if loginErr := a.ensureLogin(ctx, profileName); loginErr != nil {
			return err
		}
		profile, err = store.ResolveProfile(profileName)
		if err != nil {
			return err
		}
	}
	secret, err := store.Credential(profile.Name)
	if err != nil {
		return err
	}
	session, err := a.Gateway.Session(ctx, profile.ServerURL, secret)
	if err != nil {
		return err
	}
	model, err = resolveLaunchModel(profile, model, session.Models)
	if err != nil {
		return err
	}
	adapter, err := AdapterByName(agent)
	if err != nil {
		return err
	}
	executable, _, err := adapter.Probe()
	if err != nil {
		return err
	}
	command, err := adapter.Prepare(LaunchContext{
		Profile:    profile,
		APIBase:    session.APIBase,
		APIKey:     secret,
		Model:      model,
		Models:     session.Models,
		Executable: executable,
		Args:       passthrough,
		Environ:    a.Environ,
		RAI:        a.Self,
	})
	if err != nil {
		return err
	}
	return a.Run(ctx, command, a.Stdin, a.Stdout, a.Stderr)
}

func splitLaunchArgs(args []string) (model string, rest []string, err error) {
	rest = make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			rest = append(rest, args[i+1:]...)
			return model, rest, nil
		}
		name, value, hasValue := strings.Cut(arg, "=")
		if name == "--model" {
			if !hasValue {
				if i+1 >= len(args) {
					return "", nil, errors.New("--model requires a value")
				}
				i++
				value = args[i]
			}
			model = value
			continue
		}
		rest = append(rest, arg)
	}
	return model, rest, nil
}

func flagsWithoutValues(args []string) []string {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "" {
			continue
		}
		out = append(out, arg)
	}
	return out
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
