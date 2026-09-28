package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

func TestCodexInteropCredentialHelper(t *testing.T) {
	if os.Getenv("RAI_INTEROP_CREDENTIAL_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	fmt.Print("fake-key")
	os.Exit(0)
}

// Opt-in real-client contract check. No real key, model request or user Codex
// configuration is used. CODEX_INTEROP_BINARY must be the native executable.
func TestCodexClientReadsRelayQuota(t *testing.T) {
	binary := os.Getenv("CODEX_INTEROP_BINARY")
	if binary == "" {
		t.Skip("CODEX_INTEROP_BINARY is not configured")
	}
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, transport := range []string{"http", "websocket", "catalog"} {
		for _, selected := range []string{"codex-one", "grok-one", ""} {
			t.Run(transport+"/"+selected, func(t *testing.T) {
				now := time.Now()
				subscriptions := []store.SubscriptionQuota{
					{ChildID: "codex-one", Name: "Codex personal", Provider: "codex", Windows: []store.ChildQuotaWindow{
						{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 30, ReservedNanoUSD: 12, ResetsAt: now.Add(24 * time.Hour)},
						{Kind: "2h", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, ResetsAt: now.Add(time.Hour)},
					}},
					{ChildID: "grok-one", Name: "Grok personal", Provider: "xai", Windows: []store.ChildQuotaWindow{
						{Kind: "7d", LimitNanoUSD: 100, SettledNanoUSD: 20, ReservedNanoUSD: 5, ResetsAt: now.Add(48 * time.Hour)},
					}},
					{ChildID: "codex-two", Name: "Codex extra", Provider: "codex", Windows: []store.ChildQuotaWindow{
						{Kind: "2h", LimitNanoUSD: 100, SettledNanoUSD: 10, ResetsAt: now.Add(time.Hour)},
					}},
				}
				quota := projectSelectedCodexQuota(subscriptions, selected, now)
				model := "gpt-5.4"
				if transport == "catalog" {
					model = "relay-interop-model"
				}
				var httpCalls, wsCalls, catalogCalls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasSuffix(r.URL.Path, "/models") {
						catalogCalls.Add(1)
						// Use the production completion/normalization pipeline. The
						// distinctive context size proves the client used this catalog.
						input, _ := json.Marshal(map[string]any{"models": []any{map[string]any{"slug": model, "context_window": 128000, "effective_context_window_percent": 100, "prefer_websockets": transport == "websocket", "supported_reasoning_levels": []any{map[string]any{"effort": "high", "description": "Probe high"}}, "default_reasoning_level": "high"}}})
						catalog, err := promoteCodexCatalogCapabilities(input, nil)
						if err != nil {
							t.Error(err)
							http.Error(w, "catalog error", 500)
							return
						}
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write(catalog)
						return
					}
					if !strings.HasSuffix(r.URL.Path, "/responses") {
						http.NotFound(w, r)
						return
					}
					if isWebSocketUpgrade(r) {
						wsCalls.Add(1)
						if !wantsCodexQuotaEvents(r) {
							t.Errorf("unrecognized real Codex UA: %q", r.UserAgent())
						}
						conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
						if err != nil {
							return
						}
						defer conn.Close()
						_ = conn.SetReadDeadline(time.Now().Add(25 * time.Second))
						for turn := 0; ; turn++ {
							var request map[string]any
							if conn.ReadJSON(&request) != nil {
								return
							}
							// Exercise replacement on the same connection as well as
							// initial state: the final snapshot must win.
							stale := projectSelectedCodexQuota(subscriptions, "codex-one", now)
							_ = conn.WriteJSON(stale)
							_ = conn.WriteJSON(quota)
							for _, event := range mockCodexResponseEvents(turn, request["generate"] == false, model) {
								if conn.WriteJSON(event) != nil {
									return
								}
							}
						}
					}
					httpCalls.Add(1)
					quota.setHeaders(w.Header())
					w.Header().Set("Content-Type", "text/event-stream")
					for _, event := range mockCodexResponseEvents(0, false, model) {
						payload, _ := json.Marshal(event)
						fmt.Fprintf(w, "data: %s\n\n", payload)
					}
				}))
				defer server.Close()
				home := t.TempDir()
				ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
				defer cancel()
				helperArgs, _ := json.Marshal([]string{"-test.run=^TestCodexInteropCredentialHelper$"})
				args := []string{"app-server", "-c", "model=" + strconv.Quote(model),
					"-c", `model_provider="relay_probe"`,
					"-c", `model_providers.relay_probe.name="RelayAPI probe"`,
					"-c", "model_providers.relay_probe.base_url=" + strconv.Quote(server.URL+"/v1"),
					"-c", `model_providers.relay_probe.wire_api="responses"`,
					"-c", "model_providers.relay_probe.auth.command=" + strconv.Quote(helper),
					"-c", "model_providers.relay_probe.auth.args=" + string(helperArgs),
					"-c", "model_providers.relay_probe.supports_websockets=" + strconv.FormatBool(transport == "websocket"),
				}
				command := exec.CommandContext(ctx, binary, args...)
				command.Env = append(os.Environ(), "CODEX_HOME="+home, "RAI_INTEROP_CREDENTIAL_HELPER=1")
				input, err := command.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				stdout, err := command.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				var stderr bytes.Buffer
				command.Stderr = &stderr
				if err := command.Start(); err != nil {
					t.Fatal(err)
				}
				defer func() { _ = command.Process.Kill() }()
				send := func(v any) {
					if err := json.NewEncoder(input).Encode(v); err != nil {
						t.Fatal(err)
					}
				}
				send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "relay_interop", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}}})
				var live bytes.Buffer
				scanner := bufio.NewScanner(stdout)
				scanner.Buffer(make([]byte, 65536), 4<<20)
				for scanner.Scan() {
					line := scanner.Bytes()
					live.Write(line)
					live.WriteByte('\n')
					var msg map[string]any
					if json.Unmarshal(line, &msg) != nil {
						continue
					}
					if msg["error"] != nil {
						t.Fatalf("app-server: %s", line)
					}
					if msg["id"] == float64(1) {
						send(map[string]any{"method": "initialized"})
						send(map[string]any{"id": 2, "method": "thread/start", "params": map[string]any{"model": model, "modelProvider": "relay_probe", "cwd": home, "approvalPolicy": "never", "sandbox": "read-only"}})
					}
					if msg["id"] == float64(2) {
						result := msg["result"].(map[string]any)
						thread := result["thread"].(map[string]any)
						send(map[string]any{"id": 3, "method": "turn/start", "params": map[string]any{"threadId": thread["id"], "input": []any{map[string]any{"type": "text", "text": "Return mock complete. Do not use tools."}}}})
					}
					if msg["method"] == "turn/completed" {
						break
					}
				}
				cancel()
				_ = command.Wait()
				output := live.Bytes()

				if transport == "websocket" && wsCalls.Load() == 0 {
					t.Fatalf("WebSocket was not exercised: %s", output)
				}
				if transport == "http" && httpCalls.Load() == 0 {
					t.Fatal("HTTP was not exercised")
				}
				if catalogCalls.Load() == 0 {
					t.Fatalf("command-auth catalog was not fetched: %s", output)
				}
				expected := quota
				found, contextFound := false, false
				count := 0
				for _, line := range strings.Split(string(output), "\n") {
					var event struct {
						Method string `json:"method"`
						Params struct {
							Quota struct {
								ID                 string `json:"limitId"`
								Primary, Secondary *struct {
									Used    float64 `json:"usedPercent"`
									Minutes int     `json:"windowDurationMins"`
									Reset   int64   `json:"resetsAt"`
								}
							} `json:"rateLimits"`
							Usage struct {
								Context int `json:"modelContextWindow"`
							} `json:"tokenUsage"`
						} `json:"params"`
					}
					if json.Unmarshal([]byte(line), &event) != nil {
						continue
					}
					if event.Method == "account/rateLimits/updated" {
						count++
						q := event.Params.Quota
						found = q.ID == expected.LimitID
						if w := expected.Limits.Primary; w != nil {
							found = found && q.Primary != nil && q.Primary.Used == w.UsedPercent && q.Primary.Minutes == w.WindowMinutes && q.Primary.Reset == w.ResetAt
						} else {
							found = found && q.Primary == nil
						}
						if w := expected.Limits.Secondary; w != nil {
							found = found && q.Secondary != nil && q.Secondary.Used == w.UsedPercent && q.Secondary.Minutes == w.WindowMinutes && q.Secondary.Reset == w.ResetAt
						} else {
							found = found && q.Secondary == nil
						}
					}
					if event.Method == "thread/tokenUsage/updated" && event.Params.Usage.Context == 128000 {
						contextFound = true
					}
				}
				if !found || count != 1 {
					t.Fatalf("selected subscription quota mismatch (updates=%d):\n%s\n%s", count, output, stderr.String())
				}
				if !contextFound {
					t.Fatalf("Codex did not adopt the remote context window:\n%s", output)
				}

			})
		}
	}
}

func mockCodexResponseEvents(turn int, prewarm bool, model string) []map[string]any {
	message := map[string]any{"id": fmt.Sprintf("msg_mock_%d", turn), "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "mock complete", "annotations": []any{}}}}
	output := []any{message}
	if prewarm {
		output = []any{}
	}
	response := map[string]any{"id": fmt.Sprintf("resp_mock_%d", turn), "object": "response", "status": "completed", "model": model, "output": output, "usage": map[string]any{"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}
	result := []map[string]any{{"type": "response.created", "response": map[string]any{"id": response["id"], "object": "response", "status": "in_progress", "output": []any{}}}}
	if !prewarm {
		result = append(result, map[string]any{"type": "response.output_item.done", "output_index": 0, "item": message})
	}
	return append(result, map[string]any{"type": "response.completed", "response": response})
}
