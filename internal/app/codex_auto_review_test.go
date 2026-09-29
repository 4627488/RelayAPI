package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestCodexAutoReviewUsesExplicitParentModel(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{
		ID: "review", Provider: "codex", Enabled: true,
		Models:   []string{"grok-4.6", "gpt-5.6-sol"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	key := reviewTestKey("key-1", "grok-4.6", "gpt-5.6-sol")
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	for _, test := range []struct{ body, want string }{
		{`{"model":"codex-auto-review","metadata":{"parent_model":"grok-4.6"}}`, "grok-4.6"},
		{`{"model":"codex-auto-review","metadata":{"session_model":"gpt-5.6-sol"}}`, "gpt-5.6-sol"},
		{`{"model":"codex-auto-review","metadata":{"parent_model":"unavailable"}}`, codexAutoReviewModel},
		{`{"model":"codex-auto-review","input":[{"role":"user","content":"Please review grok-4.6"}]}`, codexAutoReviewModel},
	} {
		if got := app.resolveCodexReviewModel(codexAutoReviewModel, key, request, []byte(test.body)); got != test.want {
			t.Errorf("body=%s: model=%q, want %q", test.body, got, test.want)
		}
	}
	aliasKey := reviewTestKey("key-1", "grok-4.6")
	aliasKey.ModelAliases = []store.APIKeyModelAlias{{Alias: "review-parent", Model: "grok-4.6"}}
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, aliasKey, request,
		[]byte(`{"metadata":{"parent_model":"review-parent"}}`)); got != "grok-4.6" {
		t.Fatalf("aliased parent model = %q", got)
	}
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, reviewTestKey("key-1", "gpt-5.6-sol"), request,
		[]byte(`{"metadata":{"parent_model":"grok-4.6"}}`)); got != codexAutoReviewModel {
		t.Fatalf("unauthorized target = %q", got)
	}
}

func TestCodexAutoReviewFollowsSameKeySession(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{
		ID: "review", Provider: "codex", Enabled: true,
		Models:   []string{"grok-4.6", "gpt-5.6-sol"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	key := reviewTestKey("key-1", "grok-4.6", "gpt-5.6-sol")
	parent := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	parent.Header.Set("Thread-Id", "thread-1")
	parent.Header.Set("Session-Id", "thread-1")
	app.rememberCodexReviewSession(key, parent, []byte(`{"client_metadata":{"thread_id":"thread-1","session_id":"thread-1"},"prompt_cache_key":"main-cache"}`), "grok-4.6")

	review := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	review.Header.Set("Thread-Id", "review-thread-1")
	review.Header.Set("X-Codex-Parent-Thread-Id", "thread-1")
	review.Header.Set("Session-Id", "thread-1")
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, key, review,
		[]byte(`{"client_metadata":{"thread_id":"review-thread-1","x-codex-parent-thread-id":"thread-1","session_id":"thread-1"},"prompt_cache_key":"review-cache"}`)); got != "grok-4.6" {
		t.Fatalf("Grok session review model = %q", got)
	}
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, reviewTestKey("key-2", "grok-4.6"), review,
		[]byte(`{"client_metadata":{"x-codex-parent-thread-id":"thread-1"}}`)); got != codexAutoReviewModel {
		t.Fatalf("cross-key review model = %q", got)
	}
	otherParent := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	otherParent.Header.Set("Thread-Id", "thread-2")
	app.rememberCodexReviewSession(key, otherParent, nil, "gpt-5.6-sol")
	otherReview := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	otherReview.Header.Set("X-Codex-Parent-Thread-Id", "thread-2")
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, key, otherReview, nil); got != "gpt-5.6-sol" {
		t.Fatalf("GPT session review model = %q", got)
	}
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, key, httptest.NewRequest(http.MethodPost, "/v1/responses", nil), nil); got != codexAutoReviewModel {
		t.Fatalf("ambiguous review model = %q", got)
	}
	cacheParent := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	app.rememberCodexReviewSession(key, cacheParent, []byte(`{"prompt_cache_key":"cache-1"}`), "grok-4.6")
	cacheReview := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	cacheReview.Header.Set("X-Prompt-Cache-Key", "cache-1")
	if got := app.resolveCodexReviewModel(codexAutoReviewModel, key, cacheReview, nil); got != "grok-4.6" {
		t.Fatalf("cache-key session review model = %q", got)
	}
}

func TestCodexReviewSessionExpires(t *testing.T) {
	var sessions codexReviewSessions
	now := time.Now()
	sessions.remember("key|thread|one", "grok-4.6", now)
	if got := sessions.lookup("key|thread|one", now.Add(codexReviewSessionTTL)); got != "" {
		t.Fatalf("expired session model = %q", got)
	}
}

func reviewTestKey(id string, models ...string) store.KeyContext {
	return store.KeyContext{APIKey: db.APIKey{ID: id, ModelAllowlist: models}, TenantModels: models}
}
