package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

func TestToBridgeCredentialsCopiesDocuments(t *testing.T) {
	original := []byte(`{"type":"codex","access_token":"secret"}`)
	credentials := toBridgeCredentials([]upstream.Credential{{
		ID: "codex-1", Label: "Codex", Provider: "codex", Enabled: true,
		Models: []string{"gpt-5"}, Document: original,
	}})
	if len(credentials) != 1 || credentials[0].ID != "codex-1" || credentials[0].Provider != "codex" {
		t.Fatalf("credentials = %#v", credentials)
	}
	credentials[0].Document[0] = 'X'
	if string(original) == string(credentials[0].Document) {
		t.Fatal("bridge credential aliased the stored document")
	}
}

func TestConvertCPATraceKeepsAttemptTimes(t *testing.T) {
	started := time.Date(2026, 8, 20, 8, 0, 0, 0, time.UTC)
	trace := convertCPATrace(relaybridge.RequestTrace{
		RequestID: "req-1", StartedAt: started, CompletedAt: started.Add(2 * time.Second),
		Attempts: []relaybridge.ExecutionAttempt{{
			Number: 1, Provider: "codex", Model: "gpt-5", CredentialID: "cred-1",
			StartedAt: started, FirstChunkAt: started.Add(200 * time.Millisecond),
			CompletedAt: started.Add(2 * time.Second), Status: "ok",
		}},
	})
	if trace.RequestID != "req-1" || len(trace.Attempts) != 1 {
		t.Fatalf("trace = %#v", trace)
	}
	if trace.Attempts[0].FirstResponseAt != started.Add(200*time.Millisecond) {
		t.Fatalf("first response = %s", trace.Attempts[0].FirstResponseAt)
	}
	if trace.Attempts[0].CredentialID != "cred-1" || trace.Attempts[0].Provider != "codex" {
		t.Fatalf("attempt = %#v", trace.Attempts[0])
	}
}

func TestServeEmbeddedCPAHandlerCallsInProcessHandler(t *testing.T) {
	var gotAuth, gotCred, gotBody, gotHost string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCred = r.Header.Get("X-Relay-CPA-Auth-ID")
		gotHost = r.Host
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		gotBody = string(body)
		w.Header().Set("X-From-Handler", "ok")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("client-body"))
	request.Header.Set("Authorization", "Bearer tenant-key")
	request.Header.Set("X-Relay-Upstream-Credential-ID", "cred-9")
	request.Header.Set("X-API-Key", "must-not-reach-cpa")
	recorder := httptest.NewRecorder()
	serveEmbeddedCPAHandler(handler, "process-key", recorder, request, []byte(`{"model":"gpt-5"}`))
	if gotAuth != "Bearer process-key" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if gotCred != "cred-9" {
		t.Fatalf("cpa auth = %q", gotCred)
	}
	if gotBody != `{"model":"gpt-5"}` {
		t.Fatalf("body = %q", gotBody)
	}
	if strings.Contains(gotHost, "127.0.0.1") {
		t.Fatalf("in-process request must not target loopback, host=%q", gotHost)
	}
	if recorder.Code != http.StatusTeapot {
		t.Fatalf("status = %d", recorder.Code)
	}
	if recorder.Header().Get("X-From-Handler") != "ok" || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("response = %d %q %q", recorder.Code, recorder.Header().Get("X-From-Handler"), recorder.Body.String())
	}
}

func TestServeEmbeddedCPAHandlerUnavailableWithoutHandler(t *testing.T) {
	recorder := httptest.NewRecorder()
	serveEmbeddedCPAHandler(nil, "process-key", recorder, httptest.NewRequest(http.MethodGet, "/v1/models", nil), nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestApplyEmbeddedCPAAuthPinsProcessKeyAndCredential(t *testing.T) {
	header := http.Header{
		"Authorization": {"Bearer tenant-key"},
		"X-API-Key":     {"public-key"},
	}
	applyEmbeddedCPAAuth(header, "process-key", "cred-9")
	if header.Get("Authorization") != "Bearer process-key" {
		t.Fatalf("authorization = %q", header.Get("Authorization"))
	}
	if header.Get("X-Relay-CPA-Auth-ID") != "cred-9" {
		t.Fatalf("cpa auth = %q", header.Get("X-Relay-CPA-Auth-ID"))
	}
	if header.Get("X-API-Key") != "" {
		t.Fatal("public API key must not reach CPA")
	}
}

func TestNativeRuntimeWebSocketHeadersKeepProcessAuth(t *testing.T) {
	header := nativeRuntimeWebSocketHeaders(http.Header{
		"Authorization": {"Bearer tenant-key"},
		"Connection":    {"Upgrade"},
		"Upgrade":       {"websocket"},
	}, "req-1", "cred-9")
	applyEmbeddedCPAAuth(header, "process-key", "cred-9")
	if header.Get("Authorization") != "Bearer process-key" {
		t.Fatalf("authorization = %q", header.Get("Authorization"))
	}
	if header.Get("X-Relay-CPA-Auth-ID") != "cred-9" || header.Get("X-Relay-Request-ID") != "req-1" {
		t.Fatalf("headers = %#v", header)
	}
	if header.Get("Connection") != "" || header.Get("Upgrade") != "" {
		t.Fatalf("handshake headers leaked: %#v", header)
	}
}

func TestRuntimeBridgeSettingsMapsImageAndCooling(t *testing.T) {
	settings := defaultNativeRuntimeSettings()
	settings.ImageGenerationMode = "disabled"
	settings.DisableCredentialCooling = true
	compiled := runtimeBridgeSettings(settings, "")
	if compiled.DisableImageGeneration != "all" {
		t.Fatalf("image mode = %q", compiled.DisableImageGeneration)
	}
	if compiled.ProxyURL != "direct" || !compiled.DisableCredentialCooling || compiled.RequestRetry != 2 {
		t.Fatalf("bridge settings = %#v", compiled)
	}
}
