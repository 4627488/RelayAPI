package relaybridge

import (
	"context"
	"os"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type testTokenStorage struct{ document []byte }

func (s testTokenStorage) SaveTokenToFile(path string) error {
	return os.WriteFile(path, s.document, 0o600)
}

func TestOAuthCaptureStoreCapturesCredentialWithoutLeavingFile(t *testing.T) {
	dir := t.TempDir()
	var captured []byte
	store := newOAuthCaptureStore(dir, func(_ context.Context, sessionID, provider, label string, document []byte) error {
		if sessionID != "relay-session" || provider != "codex" || label != "Test" {
			t.Fatalf("unexpected capture metadata: %q %q %q", sessionID, provider, label)
		}
		captured = append([]byte(nil), document...)
		return nil
	})
	ctx := coreauth.WithRequestInfo(context.Background(), &coreauth.RequestInfo{Query: map[string][]string{"relay_session": {"relay-session"}}})
	_, err := store.Save(ctx, &coreauth.Auth{Provider: "codex", Label: "Test", Storage: testTokenStorage{document: []byte(`{"type":"codex","access_token":"secret"}`)}})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if string(captured) != `{"type":"codex","access_token":"secret"}` {
		t.Fatalf("unexpected captured document: %s", captured)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("temporary OAuth credential was not removed: %v", entries)
	}
}

func TestRuntimeStartsAndCancelsCodexOAuthSession(t *testing.T) {
	runtime, err := NewRuntime(Options{
		APIKey: "test-key",
		OnOAuthCredential: func(context.Context, string, string, string, []byte) error {
			return nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	defer runtime.Close(context.Background())

	result, err := runtime.StartOAuth(context.Background(), "codex", "relay-session")
	if err != nil {
		t.Fatalf("StartOAuth: %v", err)
	}
	if result.State == "" || result.URL == "" || result.Flow != "callback" {
		t.Fatalf("unexpected OAuth start result: %#v", result)
	}
	if err = runtime.CancelOAuth(context.Background(), result.State); err != nil {
		t.Fatalf("CancelOAuth: %v", err)
	}
}
