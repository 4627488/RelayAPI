package app

import (
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
