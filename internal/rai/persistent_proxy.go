package rai

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// A daemon-backed client must not retain an ephemeral port whose owner exits
// with its terminal. This process owns only the loopback transport; credentials
// remain in the normal rai store and are resolved for every request.
type proxyState struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	Token   string `json:"token"`
}

func profileProxyID(store Store, profile Profile) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(store.Home+"\x00"+profile.Name+"\x00"+profile.ServerURL)))[:24]
}

func proxyStatePath(store Store, profile Profile) string {
	return filepath.Join(store.Home, "proxies", profileProxyID(store, profile)+".json")
}

func proxyRequest(ctx context.Context, state proxyState, method, path string) (bool, error) {
	if !localProxyURL(state.URL) || state.Token == "" {
		return false, errors.New("invalid local proxy state")
	}
	req, err := http.NewRequestWithContext(ctx, method, state.URL+path, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+state.Token)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	return resp.StatusCode >= 200 && resp.StatusCode < 300, nil
}

func localProxyURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && net.ParseIP(u.Hostname()).IsLoopback()
}

func requireLocalClientCredential(ctx LaunchContext) error {
	if !strings.HasPrefix(ctx.APIKey, "rai_local_") || !localProxyURL(ctx.APIBase) {
		return errors.New("daemon-backed client configuration requires a local rai proxy credential")
	}
	return nil
}

func readProxyState(store Store, profile Profile) (proxyState, error) {
	var state proxyState
	raw, err := os.ReadFile(proxyStatePath(store, profile))
	if err == nil {
		err = json.Unmarshal(raw, &state)
	}
	return state, err
}

func (a *App) ensurePersistentProxy(ctx context.Context, store Store, profile Profile) (string, string, error) {
	unlock, err := a.lockOAuthCredential(ctx, store, "proxy-"+profileProxyID(store, profile))
	if err != nil {
		return "", "", err
	}
	defer unlock()
	if state, err := readProxyState(store, profile); err == nil {
		if ok, _ := proxyRequest(ctx, state, http.MethodGet, "/_rai/health"); ok && state.Version == Version {
			return state.URL, state.Token, nil
		}
		_, _ = proxyRequest(ctx, state, http.MethodPost, "/_rai/stop")
	}
	_ = os.Remove(proxyStatePath(store, profile))
	cmd := exec.Command(a.Self, "--profile", profile.Name, "proxy", "serve", "--home", store.Home, "--server", profile.ServerURL)
	cmd.Env = a.Environ
	detachProxy(cmd)
	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("start background credential proxy: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return "", "", ctx.Err()
		case <-timer.C:
			_ = cmd.Process.Kill()
			return "", "", errors.New("background credential proxy did not become ready")
		case err := <-exited:
			return "", "", fmt.Errorf("background credential proxy exited before readiness: %v", err)
		case <-tick.C:
			if state, err := readProxyState(store, profile); err == nil {
				if ok, _ := proxyRequest(ctx, state, http.MethodGet, "/_rai/health"); ok {
					return state.URL, state.Token, nil
				}
			}
		}
	}
}

func (a *App) proxyCommand(ctx context.Context, profileName string, args []string) error {
	if len(args) == 0 || hasHelp(args) {
		fmt.Fprintln(a.Stdout, "Usage: rai [--profile <name>] proxy status|stop\nDaemon-backed agents use a local credential proxy; stop it when background work is finished.")
		return nil
	}
	operation := args[0]
	home, server := a.Home, ""
	for i := 1; i < len(args); i++ {
		if (args[i] != "--home" && args[i] != "--server") || i+1 >= len(args) {
			return errors.New("invalid proxy arguments")
		}
		name := args[i]
		i++
		if name == "--home" {
			home = args[i]
		} else {
			server = args[i]
		}
	}
	store, err := OpenStore(home)
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	if server != "" && server != profile.ServerURL {
		return errors.New("proxy server does not match profile")
	}
	switch operation {
	case "serve":
		return a.servePersistentProxy(ctx, store, profile)
	case "status", "stop":
		state, err := readProxyState(store, profile)
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(a.Stdout, "Proxy is stopped")
			return nil
		}
		if err != nil {
			return err
		}
		method, path := http.MethodGet, "/_rai/health"
		if operation == "stop" {
			method, path = http.MethodPost, "/_rai/stop"
		}
		ok, _ := proxyRequest(ctx, state, method, path)
		if !ok {
			fmt.Fprintln(a.Stdout, "Proxy is stopped")
			return nil
		}
		if operation == "stop" {
			fmt.Fprintln(a.Stdout, "Proxy stopping; background agents will need rai to reconnect")
		} else {
			fmt.Fprintln(a.Stdout, "Proxy is running on loopback")
		}
		return nil
	default:
		return errors.New("usage: rai proxy status|stop")
	}
}

func (a *App) servePersistentProxy(ctx context.Context, store Store, profile Profile) error {
	server, listener, token, err := a.newProfileProxy(ctx, store, profile, true)
	if err != nil {
		return err
	}
	defer listener.Close()
	state := proxyState{Version: Version, URL: "http://" + listener.Addr().String(), Token: token}
	raw, _ := json.Marshal(state)
	path := proxyStatePath(store, profile)
	if err := writeFileAtomic(path, raw, 0o600); err != nil {
		return err
	}
	defer func() {
		// A successor may already own the state file.
		if current, err := readProxyState(store, profile); err == nil && current.Token == token {
			_ = os.Remove(path)
		}
	}()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Distinguish rai's provider from unrelated saved credentials, deployments,
// and profiles in the same client configuration.
func launchProviderID(ctx LaunchContext) string {
	return "relayapi_" + fmt.Sprintf("%x", sha256.Sum256([]byte(ctx.RAIHome+"\x00"+ctx.Profile.Name+"\x00"+ctx.Profile.ServerURL)))[:16]
}

func clientHome(environ []string, env, fallback string) (string, error) {
	if dir := environmentValue(environ, env); dir != "" {
		return filepath.Abs(dir)
	}
	home := environmentValue(environ, "HOME")
	if home == "" {
		home = environmentValue(environ, "USERPROFILE")
	}
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(home, filepath.FromSlash(strings.TrimPrefix(fallback, "/"))), nil
}
