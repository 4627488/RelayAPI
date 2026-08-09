package app

import (
	"encoding/json"
	"testing"
)

func TestProviderOAuthSessionsCaptureAndRemove(t *testing.T) {
	sessions := newProviderOAuthSessions()
	session := sessions.create("codex")
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
	session := sessions.create("claude")
	if err := sessions.capture(session.ID, "codex", "", []byte(`{"type":"codex"}`)); err == nil {
		t.Fatal("expected provider mismatch error")
	}
}

func TestNormalizedOAuthProvider(t *testing.T) {
	tests := map[string]string{"anthropic": "claude", "openai": "codex", "grok": "xai", "kimi": "kimi"}
	for input, want := range tests {
		if got := normalizedOAuthProvider(input); got != want {
			t.Errorf("normalizedOAuthProvider(%q) = %q, want %q", input, got, want)
		}
	}
}
