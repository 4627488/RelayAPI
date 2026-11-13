package upstream

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCodexOnlyRuntimeRejectsOtherProvidersAndProtocols(t *testing.T) {
	for _, provider := range []string{"openai", "openai-compatible", "kimi", "xai", "claude", "gemini", "cursor"} {
		if _, err := NewRuntime(Options{}, []Credential{{ID: "other", Provider: provider, Enabled: true, Document: []byte(`{}`)}}); err == nil {
			t.Fatalf("accepted %s", provider)
		}
	}
	calls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) }))
	defer backend.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "test", "base_url": backend.URL})})
	for _, path := range []string{"/v1/chat/completions", "/v1/messages", "/v1/images/generations", "/v1/embeddings", "/v1/realtime", "/v1beta/models/x:generateContent"} {
		w := httptest.NewRecorder()
		runtime.Serve(w, httptest.NewRequest("POST", path, nil), []byte(`{"model":"model"}`))
		if w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("removed protocols reached upstream")
	}
}

func TestCodexResponsesPreserveOpaqueToolPayloadAndTerminalUsage(t *testing.T) {
	payload := `{"model":"model","stream":true,"input":[{"type":"custom_tool_call_output","call_id":"opaque","output":"done"}],"tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}],"unknown_future_field":{"keep":true}}`
	terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"model\":\"model\",\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":80},\"output_tokens\":20,\"output_tokens_details\":{\"reasoning_tokens\":5}}}}\n\n"
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/responses" || !strings.Contains(string(body), `"unknown_future_field":{"keep":true}`) || !strings.Contains(string(body), `"type":"custom"`) {
			t.Errorf("payload changed: %s %s", r.URL.Path, body)
		}
		if r.Header.Get("X-Relay-Request-ID") != "" {
			t.Error("private runtime header leaked")
		}
		if r.Header.Get("Authorization") != "Bearer upstream-key" || r.Header.Get("Accept-Encoding") != "identity" {
			t.Error("credentials/compression policy")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(terminal))
	}))
	defer backend.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"api_key": "upstream-key", "base_url": backend.URL})})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/v1/responses", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("X-Relay-Request-ID", "private-id")
	runtime.Serve(w, r, []byte(payload))
	if w.Code != 200 || w.Body.String() != terminal {
		t.Fatalf("response changed: %d %s", w.Code, w.Body.String())
	}
}

func TestCodexPinnedCredentialCannotEscapeModelAndCoolingPreservesRoutes(t *testing.T) {
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: []byte(`{"api_key":"key"}`)})
	r := runtime.(*nativeRuntime)
	if _, ok := r.selectCredential("unowned", "codex", ""); ok {
		t.Fatal("pin bypassed model policy")
	}
	c := r.credentials["codex"]
	c.record(false, "test", true, 1, time.Hour)
	if _, ok := r.selectCredential("model", "", ""); ok {
		t.Fatal("cooling credential selected")
	}
	c.mu.Lock()
	c.Status.NextRetryAfter = time.Now().Add(-time.Second)
	c.mu.Unlock()
	if _, ok := r.selectCredential("model", "", ""); !ok {
		t.Fatal("cooldown removed route permanently")
	}
}

func TestCodexCompactStaysNativeNonStreaming(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/responses/compact" || strings.Contains(string(body), `"stream":true`) {
			t.Errorf("compact rewritten: %s %s", r.URL.Path, body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cmp_1","object":"response.compaction","output":[]}`))
	}))
	defer backend.Close()
	runtime := newTestRuntime(t, Credential{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"access_token": "token", "base_url": backend.URL})})
	w := httptest.NewRecorder()
	runtime.Serve(w, httptest.NewRequest("POST", "/v1/responses/compact", nil), []byte(`{"model":"model","input":[]}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"cmp_1"`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestCodex401RefreshRetriesOnlySameCredential(t *testing.T) {
	calls, refreshes := 0, 0
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh","refresh_token":"rotated","expires_in":3600}`))
	}))
	defer oauth.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fresh" {
			t.Error("stale credential retried")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_ok","usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer backend.Close()
	persisted := 0
	runtime, err := NewRuntime(Options{OnCredentialUpdated: func(_ context.Context, id string, document []byte) {
		persisted++
		if id != "codex" || !strings.Contains(string(document), "rotated") {
			t.Error("refresh identity/document lost")
		}
	}}, []Credential{{ID: "codex", Provider: "codex", Enabled: true, Models: []string{"model"}, Document: testJSON(t, map[string]any{"access_token": "old", "refresh_token": "refresh", "expired": time.Now().Add(time.Hour).Format(time.RFC3339), "base_url": backend.URL, "token_endpoint": oauth.URL})}})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(t.Context())
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/v1/responses/compact", nil)
	r.Header.Set("X-Relay-Upstream-Credential-ID", "codex")
	runtime.Serve(w, r, []byte(`{"model":"model","input":[]}`))
	if w.Code != 200 || calls != 2 || refreshes != 1 || persisted != 1 {
		t.Fatalf("status=%d calls=%d refreshes=%d persisted=%d", w.Code, calls, refreshes, persisted)
	}
}
