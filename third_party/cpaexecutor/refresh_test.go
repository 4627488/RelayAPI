package relaybridge

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type refreshTestExecutor struct {
	coreauth.ProviderExecutor
	provider string
	calls    int
	err      error
}

func (e *refreshTestExecutor) Identifier() string { return e.provider }
func (e *refreshTestExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	e.calls++
	if e.err != nil {
		return nil, e.err
	}
	auth.Metadata["access_token"] = "new-access"
	auth.Metadata["refresh_token"] = "new-refresh"
	auth.Metadata["expired"] = time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	return auth, nil
}

func TestRefreshCredentialUsesCPALifecycle(t *testing.T) {
	for _, provider := range []string{"kimi", "codex", "xai"} {
		t.Run(provider, func(t *testing.T) {
			var persisted []byte
			manager := coreauth.NewManager(nil, nil, runtimeAuthHook{updated: func(_ context.Context, _ string, document []byte) { persisted = append([]byte(nil), document...) }})
			exec := &refreshTestExecutor{provider: provider}
			manager.RegisterExecutor(exec)
			_, err := manager.Register(t.Context(), &coreauth.Auth{ID: "credential", Provider: provider, Status: coreauth.StatusActive, Metadata: map[string]any{
				"type": provider, "access_token": "old-access", "refresh_token": "old-refresh", "expired": time.Now().Add(48 * time.Hour).Format(time.RFC3339),
			}})
			if err != nil {
				t.Fatal(err)
			}
			runtime := &Runtime{manager: manager}
			fresh, refreshed, err := runtime.RefreshCredential(t.Context(), "credential", false)
			if err != nil || refreshed || exec.calls != 0 {
				t.Fatalf("fresh refreshed=%v err=%v", refreshed, err)
			}
			var document map[string]any
			if json.Unmarshal(fresh, &document) != nil || document["access_token"] != "old-access" {
				t.Fatal("fresh snapshot missing")
			}
			updated, refreshed, err := runtime.RefreshCredential(t.Context(), "credential", true)
			if err != nil || !refreshed || exec.calls != 1 {
				t.Fatalf("forced refreshed=%v err=%v", refreshed, err)
			}
			if string(persisted) != string(updated) {
				t.Fatal("CPA hook did not persist refreshed document")
			}
			if json.Unmarshal(updated, &document) != nil || document["access_token"] != "new-access" || document["refresh_token"] != "new-refresh" {
				t.Fatal("rotated tokens missing")
			}
			latest, refreshed, err := runtime.RefreshCredential(t.Context(), "credential", false)
			if err != nil || refreshed || string(latest) != string(updated) || exec.calls != 1 {
				t.Fatal("latest runtime snapshot not reused")
			}
			exec.err = errors.New("refresh rejected")
			if _, refreshed, err = runtime.RefreshCredential(t.Context(), "credential", true); err == nil || refreshed {
				t.Fatal("refresh failure suppressed")
			}
			if _, _, err = runtime.RefreshCredential(t.Context(), "missing", true); err == nil {
				t.Fatal("missing credential accepted")
			}
		})
	}
}
