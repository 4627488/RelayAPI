package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
)

// A real Codex process must rerun the helper after a 401 and continue with a
// rotated access token. The clock jump simulates expiry without a 15-minute test.
func TestCodexClientRenewsOAuthAfter401(t *testing.T) {
	binary := os.Getenv("CODEX_INTEROP_BINARY")
	if binary == "" {
		t.Skip("CODEX_INTEROP_BINARY is not configured")
	}
	t.Setenv(envDisableKey, "1")
	helper := filepath.Join(t.TempDir(), "rai")
	if out, err := exec.Command("go", "build", "-o", helper, "../../cmd/rai").CombinedOutput(); err != nil {
		t.Fatalf("helper build: %v: %s", err, out)
	}
	a := &App{Home: t.TempDir(), Stdout: io.Discard, Stderr: io.Discard}
	a.defaults()
	var s Store
	var p Profile
	var requests, refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			item := upstream.NewCodexCatalogItem("interop-renew")
			item["supported_reasoning_levels"] = []any{map[string]string{"effort": "none", "description": "None"}}
			item["default_reasoning_level"] = "none"
			json.NewEncoder(w).Encode(map[string]any{"models": []any{item}})
		case "/api/rai/token":
			refreshes.Add(1)
			io.WriteString(w, `{"access_token":"rai_at_renewed","refresh_token":"rai_rt_rotated","purpose":"inference","expires_in":899}`)
		case "/v1/responses":
			requests.Add(1)
			if r.Header.Get("Authorization") == "Bearer rai_at_initial" {
				raw := encodeOAuthCredential(p.ServerURL, TokenResult{AccessToken: "rai_at_initial", RefreshToken: "rai_rt_initial", Purpose: "inference", ExpiresIn: 1}, time.Now().Add(-time.Hour))
				if _, err := s.PutCredential(profileCredentialName(p), raw); err != nil {
					t.Error(err)
				}
				http.Error(w, `{"error":{"type":"authentication_error","code":"invalid_api_key","message":"expired"}}`, http.StatusUnauthorized)
				return
			}
			if r.Header.Get("Authorization") != "Bearer rai_at_renewed" {
				t.Errorf("unexpected credential")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			response := `{"id":"resp_renewed","object":"response","status":"completed","model":"interop-renew","output":[{"id":"msg_renewed","type":"message","role":"assistant","content":[{"type":"output_text","text":"renewed"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}`
			io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":"+response+"}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	s, p = saveTestOAuth(t, a, server.URL, "inference", time.Now().Add(time.Hour))
	home := t.TempDir()
	argsJSON, _ := json.Marshal([]string{"--profile", p.Name, "credential", "print", "--home", s.Home, "--server", server.URL})
	args := []string{"exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-m", "interop-renew"}
	for _, override := range []string{"model_provider=renewal", `model_providers.renewal.name="Renewal"`, "model_providers.renewal.base_url=" + strconv.Quote(server.URL+"/v1"), "model_providers.renewal.wire_api=responses", "model_providers.renewal.supports_websockets=false", "model_providers.renewal.auth.command=" + strconv.Quote(helper), "model_providers.renewal.auth.args=" + string(argsJSON), "model_providers.renewal.auth.timeout_ms=30000", "model_providers.renewal.auth.refresh_interval_ms=60000"} {
		args = append(args, "-c", override)
	}
	args = append(args, "say renewed")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, args...)
	command.Dir = home
	command.Env = append(os.Environ(), "CODEX_HOME="+home)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("renewal failed: %v: %s", err, output)
	}
	if requests.Load() < 2 || refreshes.Load() != 1 || !bytes.Contains(output, []byte("renewed")) {
		t.Fatalf("requests=%d refreshes=%d: %s", requests.Load(), refreshes.Load(), output)
	}
	saved, _ := s.Credential(profileCredentialName(p))
	if !strings.Contains(saved, "rai_rt_rotated") {
		t.Fatal("rotating refresh token was not persisted")
	}
}
