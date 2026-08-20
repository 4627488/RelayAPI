package upstream

import (
	"net/http"
	"strings"
	"time"
)

const credentialSessionAffinityTTL = time.Hour

type affinityEntry struct {
	credentialID string
	expiresAt    time.Time
}

func (c *nativeCredential) usesSessionAffinity() bool {
	return c != nil && (c.Provider == "aliyun-bailian" || c.SessionAffinity)
}

func sessionAffinityKey(body []byte, header http.Header) string {
	if key := jsonString(body, "prompt_cache_key"); key != "" {
		return "cache:" + key
	}
	if key := jsonString(body, "previous_response_id"); key != "" {
		return "response:" + key
	}
	if key := jsonString(body, "user"); key != "" {
		return "user:" + key
	}
	if header == nil {
		return ""
	}
	for _, name := range []string{"X-Prompt-Cache-Key", "X-Session-Affinity", "X-Dashscope-Session-Id"} {
		if key := strings.TrimSpace(header.Get(name)); key != "" {
			return "header:" + strings.ToLower(name) + ":" + key
		}
	}
	return ""
}

func (r *nativeRuntime) rememberAffinity(key string, credential *nativeCredential) {
	if key == "" || !credential.usesSessionAffinity() {
		return
	}
	r.mu.Lock()
	if r.affinity == nil {
		r.affinity = make(map[string]affinityEntry)
	}
	r.affinity[key] = affinityEntry{credentialID: credential.ID, expiresAt: time.Now().Add(credentialSessionAffinityTTL)}
	if len(r.affinity) > 4096 {
		now := time.Now()
		for existing, entry := range r.affinity {
			if now.After(entry.expiresAt) {
				delete(r.affinity, existing)
			}
		}
	}
	r.mu.Unlock()
}

func (r *nativeRuntime) affinityCredential(key string, model string, now time.Time) *nativeCredential {
	if key == "" {
		return nil
	}
	r.mu.Lock()
	if r.affinity == nil {
		r.mu.Unlock()
		return nil
	}
	entry, ok := r.affinity[key]
	if !ok {
		r.mu.Unlock()
		return nil
	}
	if now.After(entry.expiresAt) {
		delete(r.affinity, key)
		r.mu.Unlock()
		return nil
	}
	credential := r.credentials[entry.credentialID]
	routes := r.modelRoutes[strings.ToLower(strings.TrimSpace(model))]
	r.mu.Unlock()
	if credential == nil || !credential.usesSessionAffinity() || !credential.available(now) {
		return nil
	}
	for _, id := range routes {
		if id == credential.ID {
			return credential
		}
	}
	return nil
}
