package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/gorilla/websocket"
)

// Opt-in installed-client check. The binary is copied so even a portable Magpie
// installation cannot use its real data folder. All child paths are disposable;
// account discovery is off and non-loopback HTTP is sent to a closed proxy.
func TestMagpieClientImportsRelayAndConvertsChatTools(t *testing.T) {
	binary := os.Getenv("MAGPIE_INTEROP_BINARY")
	if binary == "" {
		t.Skip("MAGPIE_INTEROP_BINARY is not configured")
	}
	home := t.TempDir()
	childBinary := filepath.Join(home, "magpie")
	input, err := os.Open(binary)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.OpenFile(childBinary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	input.Close()
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatalf("copy Magpie: %v, close: %v", copyErr, closeErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	env := []string{
		"PATH=" + home, "HOME=" + home, "USERPROFILE=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, "config"), "XDG_CACHE_HOME=" + filepath.Join(home, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, "data"), "XDG_STATE_HOME=" + filepath.Join(home, "state"),
		"APPDATA=" + filepath.Join(home, "config"), "LOCALAPPDATA=" + filepath.Join(home, "data"),
		"TMPDIR=" + home, "MAGPIE_NO_ACCOUNTS=1", "MAGPIE_ADDR=" + address,
		"HTTP_PROXY=http://127.0.0.1:1", "HTTPS_PROXY=http://127.0.0.1:1", "NO_PROXY=127.0.0.1,localhost,::1",
		"NO_COLOR=1", "TERM=dumb",
	}
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, childBinary, args...)
		cmd.Dir, cmd.Env, cmd.WaitDelay = home, env, 3*time.Second
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("magpie %s: %v\n%s", args[0], err, out)
		}
		return out
	}
	t.Log(strings.TrimSpace(string(run("--version"))))
	const model = "relay-interop-unknown-model"
	const plain = "relay-interop-fake-key"
	key := store.KeyContext{APIKey: store.APIKey{ID: "interop", Name: "Interop", Enabled: true}, TenantModels: []string{model}, TenantBalance: 42e9}
	app := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{model}, Document: []byte(`{"type":"codex","access_token":"fake"}`)})
	app.setCapabilities(pricing.NewCapabilityIndex("interop", []pricing.Capability{{ID: model, Source: pricing.SourceAdmin, Context: 1000000, MaxOutput: 128000, InputModalities: []string{"text", "image"}, Reasoning: true, ReasoningOptions: []pricing.ReasoningOption{{Type: "effort", Values: []string{"low", "high"}}}}}))
	var models, responses, toolCalls, toolResults, wrongPaths, socketTurns, nativeCompacts, usageQueries, exhaustedAttempts atomic.Int32
	quotaNow := time.Now().UTC().Truncate(time.Second)
	interopQuotas := []store.SubscriptionQuota{{ChildID: "share", Name: "Codex plan", Models: []string{model}, Windows: []store.ChildQuotaWindow{
		{Kind: "5h", LimitNanoUSD: 100e9, SettledNanoUSD: 20e9, ReservedNanoUSD: 5e9, ResetsAt: quotaNow.Add(time.Hour)},
		{Kind: "7d", LimitNanoUSD: 800e9, SettledNanoUSD: 100e9, ReservedNanoUSD: 20e9, ResetsAt: quotaNow.Add(3 * 24 * time.Hour)},
	}}}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+plain && r.Header.Get("Authorization") != "Bearer "+plain+"-exhausted" {
			t.Errorf("Magpie omitted the imported API key on %s", r.URL.Path)
			http.Error(w, "invalid key", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/usage":
			usageQueries.Add(1)
			qs := interopQuotas
			if strings.HasSuffix(r.Header.Get("Authorization"), "-exhausted") {
				q := qs[0]
				q.Windows = append([]store.ChildQuotaWindow(nil), q.Windows...)
				q.Windows[0].SettledNanoUSD = q.Windows[0].LimitNanoUSD
				qs = []store.SubscriptionQuota{q}
			}
			writeJSON(w, http.StatusOK, projectMagpieUsage(key, qs, []string{model}, quotaNow))
		case "/v1/models":
			models.Add(1)
			app.serveModelCatalog(w, r, key)
		case "/v1/responses", "/v1/responses/compact":
			if strings.HasSuffix(r.Header.Get("Authorization"), "-exhausted") {
				exhaustedAttempts.Add(1)
				writeUserFacingError(w, admissionUserError(store.ErrSubscriptionExhausted))
				return
			}
			respond := func(body []byte, stream bool, writer http.ResponseWriter) {
				responses.Add(1)
				var request map[string]any
				if json.Unmarshal(body, &request) != nil || request["model"] != model {
					t.Errorf("incorrect Responses request: %s", body)
				}
				kind := "message"
				if bytes.Contains(body, []byte(`"compaction_trigger"`)) || strings.HasSuffix(r.URL.Path, "/compact") {
					nativeCompacts.Add(1)
					kind = "compaction"
				} else if bytes.Contains(body, []byte(`"function_call_output"`)) {
					toolResults.Add(1)
				} else if bytes.Contains(body, []byte(`"relay_echo"`)) {
					toolCalls.Add(1)
					kind = "function_call"
				}
				writeMagpieInteropResponse(writer, stream, kind, model)
			}
			if websocket.IsWebSocketUpgrade(r) {
				conn, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if e != nil {
					return
				}
				defer conn.Close()
				for {
					_, body, e := conn.ReadMessage()
					if e != nil {
						return
					}
					socketTurns.Add(1)
					recorder := httptest.NewRecorder()
					respond(body, true, recorder)
					for _, line := range strings.Split(recorder.Body.String(), "\n") {
						if strings.HasPrefix(line, "data: ") {
							if conn.WriteMessage(websocket.TextMessage, []byte(strings.TrimPrefix(line, "data: "))) != nil {
								return
							}
						}
					}
				}
			} else {
				body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
				var request map[string]any
				_ = json.Unmarshal(body, &request)
				respond(body, request["stream"] == true, w)
			}

		default:
			wrongPaths.Add(1)
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	_, fragment, _ := strings.Cut(magpieImportURL(backend.URL, plain, key.APIKey), "#")
	params, err := url.ParseQuery(fragment)
	if err != nil {
		t.Fatal(err)
	}
	providerID := strings.Trim(regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(params.Get("id")), "-"), "-")
	run("import", "-y", "magpie://import?"+fragment)
	run("provider", "models", providerID)
	run("provider", "test", providerID, model)
	command := strings.Fields(magpieConfigureCommand(backend.URL, key.APIKey, true))
	run(append(command[1:], "balance="+backend.URL+"/v1/usage", "balance.path="+magpieBalancePath, "billing=plan")...)
	var cards []struct {
		Provider, Error string
		Windows         []struct {
			Name                           string
			Used, Remaining, Amount, Limit float64
			Unit                           string
			ResetsAt                       *time.Time
		}
	}
	quotaJSON := run("quota", "refresh", providerID, "--json")
	if err := json.Unmarshal(quotaJSON, &cards); err != nil || len(cards) != 1 || cards[0].Error != "" {
		t.Fatalf("Magpie could not read sub2api usage: %v: %s", err, quotaJSON)
	}
	found := 0
	for _, w := range cards[0].Windows {
		if w.Name == "5 hours" {
			found++
			if w.Used != 25 || w.Remaining != 75 || w.Amount != 25 || w.Limit != 100 || w.Unit != "USD" || w.ResetsAt == nil || !w.ResetsAt.Equal(interopQuotas[0].Windows[0].ResetsAt) {
				t.Fatalf("Magpie misread reserved 5h quota: %+v", w)
			}
		}
		if w.Name == "7 days" {
			found++
			if w.Used != 15 || w.Remaining != 85 || w.Limit != 800 {
				t.Fatalf("Magpie misread independent week: %+v", w)
			}
		}
	}
	if found != 2 {
		t.Fatalf("native windows absent: %s", quotaJSON)
	}
	// A second isolated key proves that real Magpie routing honors the
	// reported window even while the Relay cash wallet has money.
	exhaustedKey := key.APIKey
	exhaustedKey.ID = "interop-exhausted"
	_, exhaustedFragment, _ := strings.Cut(magpieImportURL(backend.URL, plain+"-exhausted", exhaustedKey), "#")
	exhaustedCommand := strings.Fields(magpieConfigureCommand(backend.URL, exhaustedKey, false))
	exhaustedID := exhaustedCommand[3]
	run("import", "-y", "magpie://import?"+exhaustedFragment)
	run(append(exhaustedCommand[1:], "balance="+backend.URL+"/v1/usage", "balance.path="+magpieBalancePath, "billing=plan")...)
	run("provider", "models", exhaustedID)
	run("quota", "refresh", exhaustedID, "--json")
	run("group", "add", "Relay quota test", "models="+exhaustedID+"/"+model+","+providerID+"/"+model, "routing=usage", "stays=off")
	cache, err := os.ReadFile(filepath.Join(home, "cache", "magpie", "models", providerID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var fetched struct {
		Models []struct {
			ID              string
			Context, Output int
			Images          bool
			Efforts, APIs   []string
		}
	}
	if err := json.Unmarshal(cache, &fetched); err != nil || len(fetched.Models) != 1 {
		t.Fatalf("Magpie did not cache the live catalog: %v: %s", err, cache)
	}
	m := fetched.Models[0]
	if m.ID != model || m.Context != 1000000 || m.Output != 128000 || !m.Images || !slices.Equal(m.Efforts, []string{"low", "high"}) || !slices.Equal(m.APIs, []string{"responses"}) {
		t.Fatalf("Magpie lost Relay's custom model facts: %+v", m)
	}
	serveCtx, stopServe := context.WithCancel(ctx)
	cmd := exec.CommandContext(serveCtx, childBinary, "serve")
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.Dir, cmd.Env, cmd.WaitDelay = home, env, 3*time.Second
	var logs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var once sync.Once
	stop := func() { once.Do(func() { stopServe(); <-done }) }
	defer stop()
	client := &http.Client{Timeout: 3 * time.Second}
	base := "http://" + address
	ready := false
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/models", nil)
		req.Header.Set("Authorization", "Bearer magpie")
		if response, err := client.Do(req); err == nil {
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			ready = response.StatusCode == http.StatusOK && bytes.Contains(body, []byte(providerID+"/"+model))
			if ready {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		stop()
		t.Fatalf("Magpie gateway did not expose the imported model:\n%s", logs.String())
	}
	chat := func(messages []map[string]any) map[string]any {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"model": providerID + "/" + model, "messages": messages, "tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "relay_echo", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}}})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer magpie")
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		payload, _ := io.ReadAll(response.Body)
		var document struct {
			Choices []struct{ Message map[string]any }
		}
		if json.Unmarshal(payload, &document) != nil || response.StatusCode != http.StatusOK || len(document.Choices) != 1 {
			t.Fatalf("Magpie Chat conversion failed: %d %s", response.StatusCode, payload)
		}
		return document.Choices[0].Message
	}
	before := responses.Load()
	probeRoute := func(route string) (int, http.Header, []byte) {
		t.Helper()
		body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hello"}]}`, route)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer magpie")
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		payload, _ := io.ReadAll(response.Body)
		response.Body.Close()
		return response.StatusCode, response.Header, payload
	}
	if status, _, payload := probeRoute("group/relay-quota-test"); status != 200 || exhaustedAttempts.Load() != 0 || responses.Load() != before+1 {
		t.Fatalf("Magpie did not prefer available quota: %d %s, exhausted=%d", status, payload, exhaustedAttempts.Load())
	}
	// Explicitly picking a full key may still try it once. Relay's normal
	// refusal must be understood as quota, not a short RPM limit or cash.
	for attempt := range 2 {
		status, headers, payload := probeRoute(exhaustedID + "/" + model)
		if status < 400 || exhaustedAttempts.Load() != 1 {
			t.Fatalf("Magpie did not rest exhausted key: %d %s, attempts=%d", status, payload, exhaustedAttempts.Load())
		}
		if attempt == 1 {
			retry, _ := strconv.Atoi(headers.Get("Retry-After"))
			if retry < 3500 || retry > 3600 {
				t.Fatalf("Magpie did not rest until the actual window reset: retry=%d, %s", retry, payload)
			}
		}
	}
	messages := []map[string]any{{"role": "user", "content": "Use relay_echo, then report its result."}}
	assistant := chat(messages)
	if !bytes.Contains(mustJSON(t, assistant), []byte(`"relay_echo"`)) {
		t.Fatalf("Responses function call did not reach Chat: %+v", assistant)
	}
	messages = append(messages, assistant, map[string]any{"role": "tool", "tool_call_id": "call_interop", "content": "echo-result"})
	if reply := chat(messages); reply["content"] != "relay tool result" {
		t.Fatalf("tool continuation failed: %+v", reply)
	}

	responsesRequest := func(path, input string, stream bool) []byte {
		t.Helper()
		body := fmt.Sprintf(`{"model":%q,"instructions":"You are Codex.","stream":%v,"store":false,"input":%s}`, providerID+"/"+model, stream, input)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer magpie")
		req.Header.Set("Content-Type", "application/json")
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		payload, _ := io.ReadAll(response.Body)
		if response.StatusCode != 200 {
			t.Fatalf("Magpie native request: %d %s", response.StatusCode, payload)
		}
		return payload
	}
	const seal = "relay-opaque-compaction-seal"
	compact := responsesRequest("/v1/responses", `[{"role":"user","content":"summarise"},{"type":"compaction_trigger"}]`, true)
	if !bytes.Contains(compact, []byte(seal)) || bytes.Contains(compact, []byte("magpie1:")) {
		t.Fatalf("Magpie summarised instead of forwarding native compaction: %s", compact)
	}
	continuation := responsesRequest("/v1/responses", `[{"type":"compaction","encrypted_content":"`+seal+`"},{"role":"user","content":"continue"}]`, true)
	if !bytes.Contains(continuation, []byte("relay tool result")) {
		t.Fatalf("native compaction continuation: %s", continuation)
	}
	if socketTurns.Load() < 2 || nativeCompacts.Load() < 1 {
		t.Fatalf("performance settings inactive: sockets=%d compactions=%d", socketTurns.Load(), nativeCompacts.Load())
	}
	if usageQueries.Load() < 2 || models.Load() == 0 || responses.Load() < 3 || toolCalls.Load() != 1 || toolResults.Load() != 1 || wrongPaths.Load() != 0 {
		t.Fatalf("unexpected upstream flow: models=%d responses=%d tool_calls=%d tool_results=%d unsupported=%d", models.Load(), responses.Load(), toolCalls.Load(), toolResults.Load(), wrongPaths.Load())
	}
}

func writeMagpieInteropResponse(w http.ResponseWriter, stream bool, kind, model string) {
	item := map[string]any{"id": "message_interop", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "relay tool result", "annotations": []any{}}}}
	if kind == "function_call" {
		item = map[string]any{"id": "function_interop", "type": "function_call", "call_id": "call_interop", "name": "relay_echo", "arguments": "{}", "status": "completed"}
	}
	if kind == "compaction" {
		item = map[string]any{"id": "cmp_interop", "type": "compaction", "encrypted_content": "relay-opaque-compaction-seal"}
	}
	response := map[string]any{"id": "resp_interop", "object": "response", "model": model, "status": "completed", "output": []any{item}, "usage": map[string]any{"input_tokens": 1000, "output_tokens": 50, "input_tokens_details": map[string]any{"cached_tokens": 900}, "output_tokens_details": map[string]any{"reasoning_tokens": 40}}}
	if !stream {
		writeJSON(w, http.StatusOK, response)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	events := []map[string]any{{"type": "response.created", "response": map[string]any{"id": "resp_interop", "model": model, "status": "in_progress"}}, {"type": "response.output_item.added", "output_index": 0, "item": item}}
	if kind == "function_call" {
		events = append(events, map[string]any{"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": "{}"})
	} else if kind != "compaction" {
		events = append(events, map[string]any{"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "relay tool result"})
	}
	events = append(events, map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item}, map[string]any{"type": "response.completed", "response": response})
	for _, event := range events {
		payload, _ := json.Marshal(event)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], payload)
	}
}
