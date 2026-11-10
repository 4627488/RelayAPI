package app

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

func claudeProtocolApp(t *testing.T, upstream string) *App {
	t.Helper()
	doc, _ := json.Marshal(map[string]any{"type": "claude", "api_key": "upstream-key", "base_url": upstream, "native_tool_search": true})
	runtime, err := relaybridge.NewRuntime(relaybridge.Options{APIKey: "internal-key", PassthroughHeaders: true}, []relaybridge.Credential{{ID: "native-claude-protocol", Provider: "claude", Enabled: true, Models: []string{"claude-sonnet-4-6"}, Document: doc}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })
	server := httptest.NewServer(runtime.Handler())
	t.Cleanup(server.Close)
	client, err := cpa.New(server.URL, "internal-key", 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{nativeCPA: client, nativeCPARuntime: runtime}
	a.nativeRuntime = &embeddedCPAAdapter{app: a}
	return a
}

func TestClaudeHeartbeatIsForwardedBeforeModelOutput(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":0}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	a := claudeProtocolApp(t, upstream.URL)
	body := []byte(`{"model":"claude-sonnet-4-6","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hello"}]}`)
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prepareRuntimeHeaders(r.Header, "heartbeat-test", "native-claude-protocol")
		out := &runtimeWriter{client: w, stream: true}
		a.proxyEmbeddedCPA(out, r, body, false)
	}))
	defer downstream.Close()
	defer finish()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Post(downstream.URL+"/v1/messages", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("X-Accel-Buffering") != "no" || !strings.Contains(response.Header.Get("Cache-Control"), "no-transform") {
		t.Fatal("stream buffering protection missing")
	}
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("heartbeat buffered until model output: %v", err)
		}
		if strings.Contains(line, `"type":"ping"`) {
			break
		}
	}
	finish()
	tail, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(tail), "message_stop") {
		t.Fatalf("stream ended incorrectly: %s %v", tail, err)
	}
}

func TestClaudeSessionCapabilitiesUseActualNativeRoute(t *testing.T) {
	a := claudeProtocolApp(t, "https://gateway.example")
	key := store.KeyContext{TenantModels: []string{"claude-sonnet-4-6"}, ModelAliases: []store.APIKeyModelAlias{{Alias: "friendly", Model: "claude-sonnet-4-6"}}}
	models := a.raiSessionModels(key)
	info := a.raiModelInfo(key, models)
	for _, id := range []string{"claude-sonnet-4-6", "friendly"} {
		if info[id].CanonicalModel != "claude-sonnet-4-6" || info[id].ToolSearch == nil || !*info[id].ToolSearch {
			t.Fatalf("capability missing for %s: %#v", id, info[id])
		}
	}
	if _, exists := info["claude-opus-4-6"]; exists {
		t.Fatal("unauthorized model leaked into session")
	}
}
