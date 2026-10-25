package app

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/tidwall/gjson"
)

const codexAutoReviewModel = "codex-auto-review"
const codexReviewSessionTTL = time.Hour

type codexReviewSession struct {
	model     string
	expiresAt time.Time
}

type codexReviewSessions struct {
	mu    sync.Mutex
	items map[string]codexReviewSession
}

// Codex sends its auto-review request as a separate inference call. Associate
// it with a main request only when both calls carry the same explicit session
// identifier. The API key is part of the lookup key to prevent cross-key reuse.
func codexReviewSessionKeys(key store.KeyContext, r *http.Request, body []byte) []string {
	if r == nil || key.ID == "" {
		return nil
	}
	keys := make([]string, 0, 12)
	for _, candidate := range []struct{ name, kind string }{
		{"X-Codex-Parent-Thread-Id", "thread"}, {"X-Codex-Thread-Id", "thread"},
		{"Thread-Id", "thread"}, {"Session-Id", "session"}, {"X-Codex-Session-Id", "session"},
		{"X-Session-Affinity", "affinity"}, {"X-Prompt-Cache-Key", "cache"},
	} {
		if value := strings.TrimSpace(r.Header.Get(candidate.name)); value != "" {
			keys = append(keys, key.ID+"|"+candidate.kind+"|"+value)
		}
	}
	for _, candidate := range []struct{ path, kind string }{
		{"client_metadata.x-codex-parent-thread-id", "thread"},
		{"client_metadata.thread_id", "thread"}, {"client_metadata.session_id", "session"},
		{"metadata.thread_id", "thread"}, {"metadata.session_id", "session"},
		{"prompt_cache_key", "cache"},
	} {
		if value := strings.TrimSpace(gjson.GetBytes(body, candidate.path).String()); value != "" {
			keys = append(keys, key.ID+"|"+candidate.kind+"|"+value)
		}
	}
	return keys
}

func (sessions *codexReviewSessions) remember(key, model string, now time.Time) {
	if key == "" || model == "" || strings.EqualFold(model, codexAutoReviewModel) {
		return
	}
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.items == nil {
		sessions.items = make(map[string]codexReviewSession)
	}
	if len(sessions.items) >= 4096 {
		for sessionKey, item := range sessions.items {
			if !now.Before(item.expiresAt) {
				delete(sessions.items, sessionKey)
			}
		}
		if len(sessions.items) >= 4096 && sessions.items[key].model == "" {
			// Do not grow without bound when clients supply unique identifiers.
			return
		}
	}
	sessions.items[key] = codexReviewSession{model: model, expiresAt: now.Add(codexReviewSessionTTL)}
}

func (sessions *codexReviewSessions) lookup(key string, now time.Time) string {
	if key == "" {
		return ""
	}
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	item, ok := sessions.items[key]
	if !ok {
		return ""
	}
	if !now.Before(item.expiresAt) {
		delete(sessions.items, key)
		return ""
	}
	return item.model
}

func explicitCodexReviewParentModel(body []byte) string {
	for _, path := range []string{"metadata.parent_model", "metadata.session_model", "metadata.original_model", "metadata.model", "session.model"} {
		if model := strings.TrimSpace(gjson.GetBytes(body, path).String()); model != "" && !strings.EqualFold(model, codexAutoReviewModel) {
			return model
		}
	}
	return ""
}

func (a *App) resolveCodexReviewModel(requested string, key store.KeyContext, r *http.Request, body []byte) string {
	if !strings.EqualFold(strings.TrimSpace(requested), codexAutoReviewModel) {
		return requested
	}
	model := explicitCodexReviewParentModel(body)
	if model == "" {
		for _, sessionKey := range codexReviewSessionKeys(key, r, body) {
			model = a.reviewSessions.lookup(sessionKey, time.Now())
			if model != "" {
				break
			}
		}
	}
	if model != "" {
		model = resolveAPIKeyModel(model, key.ModelAliases).Model
	}
	if model == "" || strings.EqualFold(model, codexAutoReviewModel) || !key.AllowsModel(model) || a.nativeRuntime == nil {
		return requested
	}
	for _, available := range a.nativeRuntime.Models() {
		if strings.EqualFold(model, available) {
			return available
		}
	}
	return requested
}

func (a *App) rememberCodexReviewSession(key store.KeyContext, r *http.Request, body []byte, model string) {
	now := time.Now()
	for _, sessionKey := range codexReviewSessionKeys(key, r, body) {
		a.reviewSessions.remember(sessionKey, model, now)
	}
}
