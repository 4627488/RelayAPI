package relaybridge

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestCursorRuntimeProtocolsAndSessionIsolation(t *testing.T) {
	for _, protocol := range []string{"responses", "chat/completions", "messages"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", protocol, stream), func(t *testing.T) {
				var sessions []string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer crsr_test" {
						t.Errorf("wrong upstream authorization")
					}
					if r.URL.Path == "/v1/models" {
						_, _ = io.WriteString(w, `{"data":[{"id":"composer-test"}]}`)
						return
					}
					if r.URL.Path != "/v1/responses" {
						t.Errorf("upstream path = %s", r.URL.Path)
					}
					body, _ := io.ReadAll(r.Body)
					if !gjson.GetBytes(body, "input").Exists() || gjson.GetBytes(body, "messages").Exists() {
						t.Errorf("invalid translated request: %s", body)
					}
					sessions = append(sessions, r.Header.Get("Session-ID"))
					payload := `{"id":"resp_cursor","object":"response","status":"completed","model":"composer-test","output":[{"id":"msg_test","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}`
					if gjson.GetBytes(body, "stream").Bool() {
						w.Header().Set("Content-Type", "text/event-stream")
						_, _ = io.WriteString(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":"+payload+"}\n\n")
					} else {
						w.Header().Set("Content-Type", "application/json")
						_, _ = io.WriteString(w, payload)
					}
				}))
				defer server.Close()
				runtime, err := NewRuntime(Options{APIKey: "relay-internal"}, []Credential{{ID: "cursor-test", Provider: "cursor", Enabled: true, Models: []string{"composer-test"}, Document: []byte(`{"type":"cursor","api_key":"crsr_test"}`)}})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = runtime.Close(context.Background()) })
				runtime.cursor.instances = map[string]*cursorProcesses{"": {baseURL: server.URL + "/v1", directory: t.TempDir()}}
				models, source, err := runtime.DiscoverCredentialModels(t.Context(), "cursor-test")
				if err != nil || len(models) != 1 || models[0] != "composer-test" || source != "cpa_upstream" {
					t.Fatalf("discovery: %v %s %v", models, source, err)
				}
				for index, principal := range []string{"tenant-a", "tenant-a", "tenant-b"} {
					body := fmt.Sprintf(`{"model":"composer-test","input":"ping","stream":%v}`, stream)
					if protocol != "responses" {
						body = fmt.Sprintf(`{"model":"composer-test","messages":[{"role":"user","content":"ping"}],"max_tokens":16,"stream":%v}`, stream)
					}
					request := httptest.NewRequest(http.MethodPost, "/v1/"+protocol, strings.NewReader(body))
					request.Header.Set("Authorization", "Bearer relay-internal")
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Session-ID", "same-client-session")
					request.Header.Set("X-Relay-Principal", principal)
					requestID := fmt.Sprintf("cursor-%d", index)
					request.Header.Set("X-Relay-Request-ID", requestID)
					response := httptest.NewRecorder()
					runtime.Handler().ServeHTTP(response, request)
					if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"error"`) {
						t.Fatalf("response: %d %s", response.Code, response.Body.String())
					}
					if !stream && !strings.Contains(response.Body.String(), "pong") {
						t.Fatalf("lost response text: %s", response.Body.String())
					}
					usage, found := runtime.RequestUsage(t.Context(), requestID, "")
					if !found || usage.InputTokens != 4 || usage.OutputTokens != 1 || usage.TotalTokens != 5 {
						t.Fatalf("Cursor usage not available for billing: %+v (found=%v)", usage, found)
					}
					runtime.ReleaseRequestUsage(requestID)
				}
				if len(sessions) != 3 || sessions[0] == "" || sessions[0] != sessions[1] || sessions[0] == sessions[2] {
					t.Fatalf("SDK session isolation failed: %v", sessions)
				}
			})
		}
	}
}

func TestCursorPreservesToolContinuationAndNativeFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		for path, want := range map[string]string{"input.0.call_id": "call_original", "input.0.output": "tool result", "input.1.phase": "commentary", "system_prompt": "custom system", "prompt_cache_key": "cache-session"} {
			if got := gjson.GetBytes(body, path).String(); got != want {
				t.Errorf("%s = %q, want %q; body: %s", path, got, want, body)
			}
		}
		_, _ = io.WriteString(w, `{"id":"resp_tool","object":"response","status":"completed","output":[{"type":"function_call","call_id":"call_next","name":"lookup","arguments":"{}"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer server.Close()
	pool := &cursorRuntimePool{instances: map[string]*cursorProcesses{"": {baseURL: server.URL + "/v1", directory: t.TempDir()}}}
	defer pool.close()
	executor := newCursorExecutor(&sdkconfig.Config{}, pool)
	auth := &cliproxyauth.Auth{ID: "cursor-a", Provider: "cursor", Attributes: map[string]string{"api_key": "crsr_test"}}
	req := cliproxyexecutor.Request{Model: "composer-test", Payload: []byte(`{"model":"composer-test","system_prompt":"custom system","prompt_cache_key":"cache-session","input":[{"type":"function_call_output","call_id":"call_original","output":"tool result"},{"role":"assistant","phase":"commentary","content":"working"}],"tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]}`)}
	result, err := executor.Execute(t.Context(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse})
	if err != nil {
		t.Fatal(err)
	}
	if gjson.GetBytes(result.Payload, "output.0.call_id").String() != "call_next" {
		t.Fatalf("lost tool call: %s", result.Payload)
	}
	if auth.Attributes["base_url"] != "" || auth.ProxyURL != "" {
		t.Fatal("executor mutated stored credential")
	}
	_, err = executor.Execute(t.Context(), auth, req, cliproxyexecutor.Options{Alt: "responses/compact"})
	if err == nil {
		t.Fatal("compact must be explicitly rejected")
	}
}

func TestCursorChildEnvironmentDoesNotInheritServerSecretsOrProxy(t *testing.T) {
	t.Setenv("CURSOR_API_KEY", "secret-default")
	t.Setenv("DATABASE_URL", "postgres://secret")
	t.Setenv("HTTP_PROXY", "http://wrong-proxy")
	env := strings.Join(cursorChildEnvironment("private-home", "direct"), "\n")
	if strings.Contains(env, "secret") || strings.Contains(env, "wrong-proxy") {
		t.Fatalf("sensitive environment inherited: %s", env)
	}
	env = strings.Join(cursorChildEnvironment("private-home", "http://account-proxy:8080"), "\n")
	if !strings.Contains(env, "HTTPS_PROXY=http://account-proxy:8080") {
		t.Fatal("account proxy missing")
	}
}

func TestCursorManagedProcessLifecycle(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node is not installed")
	}
	root := t.TempDir()
	for _, dir := range []string{"bridge", "dist/runtime/sidecar"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	bridge := `import http from 'node:http'; http.createServer((q,r)=>r.end('ok')).listen(Number(process.env.CURSOR_SDK_BRIDGE_PORT),'127.0.0.1');`
	api := `const http=require('node:http'); http.createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');`
	if err := os.WriteFile(filepath.Join(root, "bridge/server.mjs"), []byte(bridge), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dist/runtime/sidecar/server.js"), []byte(api), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RELAY_CURSOR_RUNTIME_DIR", root)
	pool := &cursorRuntimePool{}
	t.Cleanup(pool.close)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := pool.endpoint(ctx, "direct")
	if err != nil {
		t.Fatal(err)
	}
	instance := pool.instances["direct"]
	second, err := pool.endpoint(ctx, "direct")
	if err != nil || first != second {
		t.Fatalf("runtime was not reused: %s %s %v", first, second, err)
	}
	_ = instance.children[0].cmd.Process.Kill()
	<-instance.children[0].done
	if _, err = pool.endpoint(ctx, "direct"); err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	pool.retain(map[string]bool{})
	if len(pool.instances) != 0 {
		t.Fatal("unused SDK processes were retained")
	}
	if _, err = os.Stat(instance.directory); !os.IsNotExist(err) {
		t.Fatal("temporary state was not cleaned")
	}
	pool.close()
	if _, err = pool.endpoint(ctx, "direct"); err == nil {
		t.Fatal("closed runtime restarted")
	}
}

func TestCursorBundledRuntimeStarts(t *testing.T) {
	if os.Getenv("RELAY_CURSOR_SMOKE") != "1" {
		t.Skip("set RELAY_CURSOR_SMOKE=1 with a built SDK runtime and Node >=24")
	}
	pool := &cursorRuntimePool{}
	defer pool.close()
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	if _, err := pool.endpoint(ctx, "direct"); err != nil {
		t.Fatal(err)
	}
}

func TestCursorStreamTerminalAndFailureHandling(t *testing.T) {
	for _, test := range []struct {
		name, payload string
		status        int
		failed        bool
	}{
		{"completed", `{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}`, 200, false},
		{"incomplete", `{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","output":[]}}`, 200, false},
		{"failed", `{"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"message":"SDK failed"}}}`, 200, true},
		{"truncated", `{"type":"response.output_text.delta","delta":"partial"}`, 200, true},
		{"invalid-json", `{"type":"response.completed"`, 200, true},
		{"rate-limit", `{"error":{"message":"rate limited"}}`, 429, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, "data: "+test.payload+"\n\n")
			}))
			defer server.Close()
			pool := &cursorRuntimePool{instances: map[string]*cursorProcesses{"": {baseURL: server.URL + "/v1", directory: t.TempDir()}}}
			defer pool.close()
			e := newCursorExecutor(&sdkconfig.Config{}, pool)
			auth := &cliproxyauth.Auth{ID: "cursor", Provider: "cursor", Attributes: map[string]string{"api_key": "crsr_test"}}
			result, err := e.ExecuteStream(t.Context(), auth, cliproxyexecutor.Request{Model: "composer-test", Payload: []byte(`{"model":"composer-test","input":"hi","stream":true}`)}, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, Stream: true})
			failed := err != nil
			if err == nil {
				for chunk := range result.Chunks {
					if chunk.Err != nil {
						failed = true
					}
				}
			}
			if failed != test.failed {
				t.Fatalf("stream failed = %v, want %v; error = %v", failed, test.failed, err)
			}
		})
	}
}
