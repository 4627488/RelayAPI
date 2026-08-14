package app

import (
	"encoding/json"
	"testing"
)

func TestProviderOAuthSessionsCaptureAndRemove(t *testing.T) {
	sessions := newProviderOAuthSessions()
	session := sessions.create("codex", "credential-existing")
	if !sessions.bindState(session.ID, "state-123") {
		t.Fatal("bindState returned false")
	}
	document := []byte(`{"type":"codex","email":"user@example.com","access_token":"secret"}`)
	if err := sessions.capture(session.ID, "codex", "Codex User", document); err != nil {
		t.Fatalf("capture: %v", err)
	}
	snapshot, ok := sessions.snapshotByState("state-123")
	if !ok {
		t.Fatal("session was not found")
	}
	if snapshot.Email != "user@example.com" || snapshot.Label != "Codex User" {
		t.Fatalf("unexpected account metadata: %#v", snapshot)
	}
	if snapshot.TargetCredentialID != "credential-existing" {
		t.Fatalf("reauthentication target was not retained: %#v", snapshot)
	}
	if !json.Valid(snapshot.Document) {
		t.Fatal("captured document is not valid JSON")
	}
	sessions.remove("state-123")
	if _, ok = sessions.snapshotByState("state-123"); ok {
		t.Fatal("removed session is still available")
	}
}

func TestProviderOAuthSessionsRejectProviderMismatch(t *testing.T) {
	sessions := newProviderOAuthSessions()
	session := sessions.create("claude", "")
	if err := sessions.capture(session.ID, "codex", "", []byte(`{"type":"codex"}`)); err == nil {
		t.Fatal("expected provider mismatch error")
	}
}

func TestMergeOAuthCredentialSettingsPreservesNonNetworkOptions(t *testing.T) {
	merged, err := mergeOAuthCredentialSettings(
		json.RawMessage(`{"type":"codex","access_token":"old","proxy_url":"socks5://proxy","prefix":"team","websockets":true,"headers":{"X-Team":"one"}}`),
		json.RawMessage(`{"type":"codex","access_token":"new","email":"new@example.com"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(merged, &document); err != nil {
		t.Fatal(err)
	}
	if document["access_token"] != "new" || document["prefix"] != "team" || document["websockets"] != true {
		t.Fatalf("unexpected merged OAuth document: %#v", document)
	}
	if _, exists := document["proxy_url"]; exists {
		t.Fatalf("legacy inline proxy survived OAuth merge: %#v", document)
	}
}

func TestNormalizedOAuthProvider(t *testing.T) {
	tests := map[string]string{"anthropic": "anthropic", "openai": "codex", "grok": "xai", "kimi": "kimi"}
	for input, want := range tests {
		if got := normalizedOAuthProvider(input); got != want {
			t.Errorf("normalizedOAuthProvider(%q) = %q, want %q", input, got, want)
		}
	}
}
