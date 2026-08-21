package relaybridge

import (
	"context"
	"strings"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func TestCredentialAffinitySelectorGatesOnAttribute(t *testing.T) {
	fallback := &coreauth.RoundRobinSelector{}
	selector := newCredentialAffinitySelector(fallback, time.Hour, "session_affinity")
	t.Cleanup(selector.Stop)

	codex := []*coreauth.Auth{{
		ID: "codex-a", Provider: "codex", Status: coreauth.StatusActive,
	}}
	opts := cliproxyexecutor.Options{Metadata: map[string]any{}, OriginalRequest: []byte(`{"model":"gpt","input":"hi"}`)}
	got, err := selector.Pick(context.Background(), "codex", "gpt", opts, codex)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "codex-a" {
		t.Fatalf("codex pick = %q", got.ID)
	}
	if status, _ := opts.Metadata[sessionAffinityStatusMetadataKey].(string); status != "disabled" {
		t.Fatalf("codex affinity status = %q, want disabled", status)
	}
}

func TestCredentialAffinitySelectorBindsPreviousResponseID(t *testing.T) {
	selector := newCredentialAffinitySelector(&coreauth.RoundRobinSelector{}, time.Hour, "session_affinity")
	t.Cleanup(selector.Stop)

	auths := []*coreauth.Auth{
		{ID: "bailian-a", Provider: "openai-compatibility", Status: coreauth.StatusActive, Attributes: map[string]string{"session_affinity": "true"}},
		{ID: "bailian-b", Provider: "openai-compatibility", Status: coreauth.StatusActive, Attributes: map[string]string{"session_affinity": "true"}},
	}
	firstOpts := cliproxyexecutor.Options{Metadata: map[string]any{responseAffinityIDMetadataKey: "resp_1"}}
	first, err := selector.Pick(context.Background(), "openai-compatibility", "qwen-plus", firstOpts, auths)
	if err != nil {
		t.Fatal(err)
	}
	selector.OnResult(coreauth.Result{
		Success: true, AuthID: first.ID, Provider: "openai-compatibility", Model: "qwen-plus",
		Options: firstOpts,
	})

	secondOpts := cliproxyexecutor.Options{
		Metadata:        map[string]any{},
		OriginalRequest: []byte(`{"model":"qwen-plus","previous_response_id":"resp_1","input":"again"}`),
	}
	second, err := selector.Pick(context.Background(), "openai-compatibility", "qwen-plus", secondOpts, auths)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("response affinity moved from %q to %q", first.ID, second.ID)
	}
	if status, _ := secondOpts.Metadata[sessionAffinityStatusMetadataKey].(string); status != "response_hit" {
		t.Fatalf("status = %q, want response_hit", status)
	}

	missingOpts := cliproxyexecutor.Options{
		Metadata:        map[string]any{},
		OriginalRequest: []byte(`{"previous_response_id":"resp_unknown"}`),
	}
	_, err = selector.Pick(context.Background(), "openai-compatibility", "qwen-plus", missingOpts, auths)
	if err == nil || !strings.Contains(err.Error(), "previous_response_affinity_missing") {
		t.Fatalf("unknown response id error = %v", err)
	}
}
