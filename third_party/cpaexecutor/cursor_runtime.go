package relaybridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SDK agents require Node, so Relay owns two private child processes rather
// than asking operators to deploy an additional public gateway. One pair is
// shared by credentials with the same egress policy; the SDK scopes agents by
// API key and Relay scopes session IDs by its authenticated principal.
type cursorRuntimePool struct {
	mu        sync.Mutex
	instances map[string]*cursorProcesses
	closed    bool
}

type cursorChild struct {
	cmd  *exec.Cmd
	done chan struct{}
}

type cursorProcesses struct {
	baseURL   string
	directory string
	children  []*cursorChild
}

func (p *cursorRuntimePool) endpoint(ctx context.Context, proxyURL string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return "", fmt.Errorf("Cursor runtime is closed")
	}
	if p.instances == nil {
		p.instances = make(map[string]*cursorProcesses)
	}
	if existing := p.instances[proxyURL]; existing != nil {
		if existing.running() {
			return existing.baseURL, nil
		}
		existing.stop()
		delete(p.instances, proxyURL)
	}
	instance, err := startCursorProcesses(ctx, proxyURL)
	if err != nil {
		return "", err
	}
	p.instances[proxyURL] = instance
	return instance.baseURL, nil
}

func (p *cursorRuntimePool) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for _, instance := range p.instances {
		instance.stop()
	}
	p.instances = nil
}

func (p *cursorProcesses) running() bool {
	for _, child := range p.children {
		select {
		case <-child.done:
			return false
		default:
		}
	}
	return true
}

func (p *cursorProcesses) stop() {
	for _, child := range p.children {
		_ = child.cmd.Process.Signal(os.Interrupt)
	}
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for _, child := range p.children {
		select {
		case <-child.done:
		case <-deadline.C:
			for _, remaining := range p.children {
				_ = remaining.cmd.Process.Kill()
			}
			for _, remaining := range p.children {
				<-remaining.done
			}
			_ = os.RemoveAll(p.directory)
			return
		}
	}
	_ = os.RemoveAll(p.directory) // exclusively allocated by MkdirTemp below
}

func (p *cursorRuntimePool) retain(proxies map[string]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for proxyURL, instance := range p.instances {
		if !proxies[proxyURL] {
			instance.stop()
			delete(p.instances, proxyURL)
		}
	}
}

func startCursorProcesses(ctx context.Context, proxyURL string) (_ *cursorProcesses, err error) {
	if proxyURL != "" && proxyURL != "direct" {
		u, parseErr := url.Parse(proxyURL)
		if parseErr != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("Cursor SDK requires an HTTP(S) account proxy")
		}
	}
	root := strings.TrimSpace(os.Getenv("RELAY_CURSOR_RUNTIME_DIR"))
	if root == "" {
		root = "/opt/relay-cursor"
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve Cursor runtime: %w", err)
	}
	for _, entry := range []string{"bridge/server.mjs", "dist/runtime/sidecar/server.js"} {
		if _, statErr := os.Stat(filepath.Join(root, filepath.FromSlash(entry))); statErr != nil {
			return nil, fmt.Errorf("Cursor SDK runtime is missing; use the Relay image or run node scripts/setup-cursor-runtime.mjs and set RELAY_CURSOR_RUNTIME_DIR")
		}
	}
	node := strings.TrimSpace(os.Getenv("RELAY_CURSOR_NODE"))
	if node == "" {
		node = "node"
	}
	dir, err := os.MkdirTemp("", "relay-cursor-*")
	if err != nil {
		return nil, fmt.Errorf("allocate Cursor runtime: %w", err)
	}
	p := &cursorProcesses{directory: dir}
	defer func() {
		if err != nil {
			p.stop()
		}
	}()
	var secret [32]byte
	if _, err = rand.Read(secret[:]); err != nil {
		return nil, err
	}
	bridgePort, err := cursorFreePort()
	if err != nil {
		return nil, err
	}
	apiPort, err := cursorFreePort()
	if err != nil {
		return nil, err
	}
	for apiPort == bridgePort {
		apiPort, err = cursorFreePort()
		if err != nil {
			return nil, err
		}
	}
	bridgeURL := "http://127.0.0.1:" + strconv.Itoa(bridgePort)
	p.baseURL = "http://127.0.0.1:" + strconv.Itoa(apiPort) + "/v1"
	env := cursorChildEnvironment(dir, proxyURL)
	env = append(env,
		"NODE_ENV=production", "HOST=127.0.0.1", "PORT="+strconv.Itoa(apiPort),
		"CURSOR_SDK_BRIDGE_HOST=127.0.0.1", "CURSOR_SDK_BRIDGE_PORT="+strconv.Itoa(bridgePort),
		"CURSOR_SDK_BRIDGE_URL="+bridgeURL+"/sdk", "CURSOR_SDK_BRIDGE_TOKEN="+hex.EncodeToString(secret[:]),
		"CURSOR_SDK_BRIDGE_AGENT_STATE_DIR="+filepath.Join(dir, "agents"),
		"CURSOR_SDK_WORKING_DIRECTORY="+dir, "XDG_STATE_HOME="+dir,
		"CURSOR_SDK_BRIDGE_MAX_JSON_BYTES=33554432",
		"CURSOR_SDK_BRIDGE_TIMEOUT_MS=310000",
	)
	startup, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	for i, entry := range []string{"bridge/server.mjs", "dist/runtime/sidecar/server.js"} {
		cmd := exec.Command(node, filepath.Join(root, filepath.FromSlash(entry)))
		cmd.Dir, cmd.Env = dir, env
		// Prompts and tool outputs must not be copied to Relay's process logs.
		if err = cmd.Start(); err != nil {
			return nil, fmt.Errorf("start Cursor SDK process: %w", err)
		}
		child := &cursorChild{cmd: cmd, done: make(chan struct{})}
		p.children = append(p.children, child)
		go func() { _ = cmd.Wait(); close(child.done) }()
		healthURL := bridgeURL + "/health"
		if i == 1 {
			healthURL = strings.TrimSuffix(p.baseURL, "/v1") + "/health"
		}
		if err = waitCursorHealthy(startup, healthURL, child.done); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func cursorChildEnvironment(dir, proxyURL string) []string {
	var env []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS":
			env = append(env, entry)
		}
	}
	env = append(env, "HOME="+dir, "USERPROFILE="+dir, "NODE_USE_ENV_PROXY=1", "NO_PROXY=127.0.0.1,localhost,::1")
	if proxyURL != "" && proxyURL != "direct" {
		env = append(env, "HTTP_PROXY="+proxyURL, "HTTPS_PROXY="+proxyURL, "CURSOR_SDK_USE_HTTP1_FOR_AGENT=1")
	}
	return env
}

func cursorFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func waitCursorHealthy(ctx context.Context, endpoint string, done <-chan struct{}) error {
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Cursor SDK startup: %w", ctx.Err())
		case <-done:
			return fmt.Errorf("Cursor SDK process exited during startup; check Node >=24 and the bundled SDK installation")
		case <-ticker.C:
		}
	}
}
