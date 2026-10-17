package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

// Never follow redirects carrying management credentials, including same-host redirects.
func (g Gateway) managementGateway() Gateway {
	client := *g.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if client.Timeout <= 0 {
		client.Timeout = 15 * time.Second
	}
	g.HTTP = &client
	return g
}

func managementServer(raw string) (string, error) {
	server, err := normalizeServerURL(raw)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(server)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("server URL must have a host and no credentials, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", errors.New("account management requires HTTPS (HTTP is allowed only on loopback)")
	}
	return server, nil
}

func (g Gateway) managementRequest(ctx context.Context, server, token, method, path string, input, output any) error {
	server, err := managementServer(server)
	if err != nil {
		return err
	}
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, server+"/api/rai/manage/"+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "rai/"+Version)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := g.managementGateway().HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("account request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return errors.New("account authorization expired or was revoked; run rai account login")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Bodies may contain secrets or untrusted terminal control sequences.
		return fmt.Errorf("account request returned HTTP %d", resp.StatusCode)
	}
	if output != nil {
		decoder := json.NewDecoder(io.LimitReader(resp.Body, 4<<20))
		decoder.UseNumber()
		return decoder.Decode(output)
	}
	return nil
}

func (a *App) accountStore() (Store, error) {
	s, err := a.store()
	if err != nil {
		return Store{}, err
	}
	return OpenStore(filepath.Join(s.Home, "account"))
}

func managementCredentialName(profile string) string { return "account/" + profile }

func (a *App) accountLogin(ctx context.Context, profileName string, args []string) error {
	f := flag.NewFlagSet("rai account login", flag.ContinueOnError)
	f.SetOutput(a.Stderr)
	server := f.String("server", "", "RelayAPI HTTPS URL")
	noBrowser := f.Bool("no-browser", false, "print the approval URL")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("usage: rai account login --server <url> [--no-browser]")
	}
	resolved, profileName, err := a.loginTarget(*server, profileName, true)
	if err != nil {
		return err
	}
	base, err := managementServer(resolved)
	if err != nil {
		return err
	}
	s, err := a.accountStore()
	if err != nil {
		return err
	}
	// Replacing a live login would orphan the old device's authorization.
	if _, err := s.ResolveProfile(profileName); err == nil {
		if raw, err := s.Credential(managementCredentialName(profileName)); err == nil {
			saved, oauth, decodeErr := decodeOAuthCredential(raw)
			if decodeErr != nil {
				return decodeErr
			}
			if oauth {
				if err := a.Gateway.revokeOAuth(ctx, saved); err != nil {
					return fmt.Errorf("revoke previous account login before replacing it: %w", err)
				}
			}
		}
	}
	verifier, err := newPKCEVerifier()
	if err != nil {
		return err
	}
	g := a.Gateway.managementGateway()
	grant, err := g.StartAuthorization(ctx, base, deviceName(), pkceChallengeS256(verifier), "account")
	if err != nil {
		return err
	}
	if err := validateVerificationURL(base, grant.VerificationURI); err != nil {
		return err
	}
	fmt.Fprintf(a.Stderr, "Approve account management (Keys, quota, usage and devices):\n%s\n", grant.VerificationURI)
	if grant.UserCode != "" && grant.DeviceVerificationURI != "" {
		if err := validateVerificationURL(base, grant.DeviceVerificationURI); err != nil {
			return err
		}
		fmt.Fprintf(a.Stderr, "Or on another device, open:\n%s\nEnter code: %s\n", grant.DeviceVerificationURI, grant.UserCode)
	}
	if !*noBrowser {
		if err := a.OpenURL(grant.VerificationURI); err != nil {
			fmt.Fprintln(a.Stderr, "Open the URL above in your browser.")
		}
	}
	ttl := time.Duration(grant.ExpiresIn) * time.Second
	if ttl <= 0 || ttl > 10*time.Minute {
		ttl = 10 * time.Minute
	}
	pollCtx, cancel := context.WithTimeout(ctx, ttl)
	defer cancel()
	interval := time.Duration(grant.Interval) * time.Second
	if interval < time.Second || interval > 30*time.Second {
		interval = 3 * time.Second
	}
	waiting := a.terminal(a.Stderr).progress("Waiting for browser approval")
	defer waiting.clear()
	for {
		result, err := g.ExchangeToken(pollCtx, base, grant.ID, verifier, "account")
		if err == nil {
			saved, _, _ := decodeOAuthCredential(encodeOAuthCredential(base, result, a.Now()))
			var session map[string]any
			if err := g.managementRequest(ctx, base, result.AccessToken, http.MethodGet, "session", nil, &session); err != nil {
				_ = g.revokeOAuth(ctx, saved)
				return err
			}
			profile := Profile{Name: profileName, ServerURL: base}
			backend, saveErr := s.PutCredential(managementCredentialName(profileName), encodeOAuthCredential(base, result, a.Now()))
			profile.CredentialBackend = backend
			if saveErr == nil {
				saveErr = s.PutProfile(profile)
			}
			if saveErr == nil {
				saveErr = s.SetActive(profileName)
			}
			if saveErr != nil {
				_ = g.revokeOAuth(ctx, saved)
				return saveErr
			}
			waiting.clear()
			return a.printManagementJSON(session)
		}
		var pending tokenError
		if !errors.As(err, &pending) || pending.Code != "authorization_pending" {
			return err
		}
		if err := a.Sleep(pollCtx, interval); err != nil {
			return err
		}
	}
}

func (a *App) printManagementJSON(value any) error {
	encoder := json.NewEncoder(a.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(true)
	return encoder.Encode(value)
}

func (a *App) manage(ctx context.Context, profileName string, args []string) error {
	if len(args) > 1 && args[0] == "account" && args[1] == "login" {
		return a.accountLogin(ctx, profileName, args[2:])
	}
	method, path := http.MethodGet, ""
	var input any
	showSecret := false
	var err error
	s, err := a.accountStore()
	if err != nil {
		return err
	}
	profile, err := s.ResolveProfile(profileName)
	if err != nil {
		return errors.New("no account management profile; run rai account login --server <url>")
	}
	if len(args) == 2 && args[0] == "account" && args[1] == "logout" {
		if err := a.revokeSavedCredential(ctx, s, managementCredentialName(profile.Name)); err != nil {
			return err
		}
		if err := s.DeleteCredential(managementCredentialName(profile.Name)); err != nil {
			return err
		}
		if err := s.DeleteProfile(profile.Name); err != nil {
			return err
		}
		return a.printManagementJSON(map[string]bool{"logged_out": true})
	}
	token, err := a.oauthAccessToken(ctx, s, profile, managementCredentialName(profile.Name), "account")
	if err != nil {
		return fmt.Errorf("account authorization unavailable; run rai account login --server <url>: %w", err)
	}
	switch args[0] {
	case "account":
		if len(args) != 2 {
			return errors.New("usage: rai account <login|status|quota|logout>")
		}
		switch args[1] {
		case "status":
			path = "account"
		case "quota":
			path = "quota"
		default:
			return errors.New("usage: rai account <login|status|quota|logout>")
		}
	case "usage":
		f := flag.NewFlagSet("rai usage", flag.ContinueOnError)
		f.SetOutput(a.Stderr)
		days := f.Int("days", 30, "report period (1-90 days)")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *days < 1 || *days > 90 {
			return errors.New("usage: rai usage [--days 1..90]")
		}
		path = fmt.Sprintf("usage?days=%d", *days)
	case "devices":
		if len(args) == 2 && args[1] == "list" {
			path = "devices"
		} else if len(args) == 4 && args[1] == "revoke" && args[3] == "--yes" {
			if err := validateManagementID(args[2]); err != nil {
				return err
			}
			method, path = http.MethodDelete, "devices/"+args[2]
		} else {
			return errors.New("usage: rai devices list | rai devices revoke <id> --yes")
		}
	case "keys":
		method, path, input, showSecret, err = a.keyManagementCommand(ctx, profile, token, args[1:])
		if err != nil {
			return err
		}
	default:
		return errors.New("unknown account command")
	}
	var result any
	var output any = &result
	if method == http.MethodDelete {
		output = nil
	}
	err = a.Gateway.managementRequest(ctx, profile.ServerURL, token, method, path, input, output)
	if err != nil {
		return err
	}
	if method == http.MethodDelete {
		result = map[string]bool{"revoked": true}
	}
	if obj, ok := result.(map[string]any); ok && !showSecret {
		delete(obj, "key")
	}
	return a.printManagementJSON(result)
}

func validateManagementID(id string) error {
	// UUIDs only: identifiers cannot inject paths or query parameters.
	if len(id) != 36 {
		return errors.New("expected a UUID from the list command")
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return errors.New("invalid UUID")
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return errors.New("invalid UUID")
		}
	}
	return nil
}

type managedKey struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	Enabled            bool              `json:"enabled"`
	RateLimitPerMinute *int              `json:"rate_limit_per_minute"`
	TokenLimitDaily    *int64            `json:"token_limit_daily"`
	ModelAllowlist     []string          `json:"model_allowlist"`
	ModelAliases       []managedKeyAlias `json:"model_aliases"`
}

type managedKeyAlias struct {
	Alias string `json:"alias"`
	Model string `json:"model"`
}

func (a *App) keyManagementCommand(ctx context.Context, profile Profile, token string, args []string) (string, string, any, bool, error) {
	fail := func(err error) (string, string, any, bool, error) { return "", "", nil, false, err }
	if len(args) == 0 {
		return fail(errors.New("usage: rai keys <list|create|update|delete>"))
	}
	if len(args) == 1 && args[0] == "list" {
		return http.MethodGet, "keys", nil, false, nil
	}
	if args[0] == "delete" {
		if len(args) != 3 || args[2] != "--yes" {
			return fail(errors.New("usage: rai keys delete <id> --yes"))
		}
		if err := validateManagementID(args[1]); err != nil {
			return fail(err)
		}
		return http.MethodDelete, "keys/" + args[1], nil, false, nil
	}
	operation, id := args[0], ""
	if operation != "create" && operation != "update" {
		return fail(errors.New("usage: rai keys <list|create|update|delete>"))
	}
	args = args[1:]
	if operation == "update" {
		if len(args) == 0 {
			return fail(errors.New("usage: rai keys update <id> [flags]"))
		}
		id, args = args[0], args[1:]
		if err := validateManagementID(id); err != nil {
			return fail(err)
		}
	}
	f := flag.NewFlagSet("rai keys "+operation, flag.ContinueOnError)
	f.SetOutput(a.Stderr)
	name := f.String("name", "", "Key name")
	enabled := f.Bool("enabled", true, "enable or disable (update only)")
	rpm := f.Int("rpm", 0, "requests per minute; 0 inherits account limit")
	daily := f.Int64("daily-tokens", 0, "daily token limit; 0 inherits account limit")
	models := f.String("models", "", "comma-separated model allowlist; empty inherits account models")
	aliases := f.String("aliases", "", "comma-separated alias=model pairs; empty clears aliases")
	show := f.Bool("show-secret", false, "include the new Key secret in JSON output (create only)")
	if err := f.Parse(args); err != nil {
		return fail(err)
	}
	if f.NArg() != 0 || *rpm < 0 || *daily < 0 {
		return fail(errors.New("invalid Key arguments"))
	}
	visited := map[string]bool{}
	f.Visit(func(v *flag.Flag) { visited[v.Name] = true })
	if (operation == "update" && *show) || (operation == "create" && visited["enabled"]) {
		return fail(errors.New("--show-secret is create-only; --enabled is update-only"))
	}
	key := managedKey{Enabled: true}
	if operation == "update" {
		var list struct {
			Items []managedKey `json:"items"`
		}
		if err := a.Gateway.managementRequest(ctx, profile.ServerURL, token, http.MethodGet, "keys", nil, &list); err != nil {
			return fail(err)
		}
		found := false
		for _, candidate := range list.Items {
			if candidate.ID == id {
				key, found = candidate, true
				break
			}
		}
		if !found {
			return fail(errors.New("Key not found in this account"))
		}
	}
	if visited["name"] {
		key.Name = strings.TrimSpace(*name)
	}
	if key.Name == "" {
		return fail(errors.New("--name is required"))
	}
	if visited["enabled"] {
		key.Enabled = *enabled
	}
	if visited["rpm"] {
		key.RateLimitPerMinute = nil
		if *rpm > 0 {
			key.RateLimitPerMinute = rpm
		}
	}
	if visited["daily-tokens"] {
		key.TokenLimitDaily = nil
		if *daily > 0 {
			key.TokenLimitDaily = daily
		}
	}
	if visited["models"] {
		key.ModelAllowlist = []string{}
		for _, model := range strings.Split(*models, ",") {
			if model = strings.TrimSpace(model); model != "" {
				key.ModelAllowlist = append(key.ModelAllowlist, model)
			}
		}
	}
	if visited["aliases"] {
		key.ModelAliases = []managedKeyAlias{}
		if strings.TrimSpace(*aliases) != "" {
			for _, pair := range strings.Split(*aliases, ",") {
				alias, model, ok := strings.Cut(pair, "=")
				alias, model = strings.TrimSpace(alias), strings.TrimSpace(model)
				if !ok || alias == "" || model == "" {
					return fail(errors.New("--aliases must contain alias=model pairs"))
				}
				key.ModelAliases = append(key.ModelAliases, managedKeyAlias{Alias: alias, Model: model})
			}
		}
	}
	// The existing browser API accepts these Go field names. Exclude the read-only ID.
	payload := map[string]any{"Name": key.Name, "Enabled": key.Enabled, "RateLimitPerMinute": key.RateLimitPerMinute,
		"TokenLimitDaily": key.TokenLimitDaily, "ModelAllowlist": key.ModelAllowlist, "ModelAliases": key.ModelAliases}
	if operation == "create" {
		return http.MethodPost, "keys", payload, *show, nil
	}
	if len(visited) == 0 {
		return fail(errors.New("provide at least one Key update flag"))
	}
	return http.MethodPut, "keys/" + id, payload, false, nil
}
