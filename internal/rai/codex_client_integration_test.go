package rai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Exercises generated persistent config and the real rai helper, never the
// user's config or a live model endpoint. Run with a native Codex executable.
func TestCodexClientUsesConfiguredHelperForCatalog(t *testing.T) {
	binary := os.Getenv("CODEX_INTEROP_BINARY")
	if binary == "" {
		t.Skip("CODEX_INTEROP_BINARY is not configured")
	}
	a, store, path := desktopTestApp(t)
	a.Self = filepath.Join(t.TempDir(), "rai.exe")
	build := exec.Command("go", "build", "-o", a.Self, "../../cmd/rai")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v: %s", err, output)
	}
	var expected atomic.Value
	expected.Store("first-secret")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+expected.Load().(string) {
			t.Error("catalog did not use current credential")
			http.Error(w, "unauthorized", 401)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"models":[]}`))
	}))
	defer server.Close()
	if err := store.PutProfile(Profile{Name: "work", ServerURL: server.URL}); err != nil {
		t.Fatal(err)
	}
	if err := runDesktopTest(t, a, "configure", "codex", "-y"); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"first-secret", "rotated-secret"} {
		expected.Store(secret)
		if _, err := store.PutCredential("work", secret); err != nil {
			t.Fatal(err)
		}
		startCalls := calls.Load()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		command := exec.CommandContext(ctx, binary, "app-server")
		command.Env = append(os.Environ(), "CODEX_HOME="+filepath.Dir(path))
		input, err := command.StdinPipe()
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		output, err := command.StdoutPipe()
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		command.Stderr = &stderr
		if err := command.Start(); err != nil {
			cancel()
			t.Fatal(err)
		}
		send := func(v any) {
			if err := json.NewEncoder(input).Encode(v); err != nil {
				t.Error(err)
			}
		}
		send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "rai_test", "version": "1"}}})
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 4<<20)
		listed := false
		for scanner.Scan() {
			var msg map[string]any
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				continue
			}
			if msg["error"] != nil {
				t.Errorf("app-server error: %s", scanner.Text())
				break
			}
			if msg["id"] == float64(1) {
				send(map[string]any{"method": "initialized"})
				send(map[string]any{"id": 2, "method": "model/list", "params": map[string]any{}})
			}
			if msg["id"] == float64(2) {
				listed = true
				break
			}
		}
		cancel()
		_ = command.Wait()
		if !listed || calls.Load() == startCalls {
			t.Fatalf("remote catalog not fetched using generated config: %s", stderr.String())
		}
		// A cold catalog on each launch demonstrates that the saved helper
		// follows rotation without rewriting the provider configuration.
		entries, _ := os.ReadDir(filepath.Dir(path))
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "models_cache") && !entry.IsDir() {
				if err := os.Remove(filepath.Join(filepath.Dir(path), entry.Name())); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}
