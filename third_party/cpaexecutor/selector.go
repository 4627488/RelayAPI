package relaybridge

import (
	"context"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/tidwall/gjson"
)

const (
	responseAffinityIDMetadataKey      = "response_affinity_id"
	sessionAffinityStatusMetadataKey   = "session_affinity_status"
	sessionAffinityProviderMetadataKey = "session_affinity_provider"
	sessionAffinityModelMetadataKey    = "session_affinity_model"
)

// credentialAffinitySelector keeps official CPA session affinity for pools that
// opt in (Bailian sets session_affinity=true) and adds strict previous_response_id
// binding. Official v7.2.137 has neither AuthAttribute gating nor response IDs.
type credentialAffinitySelector struct {
	inner         *coreauth.SessionAffinitySelector
	fallback      coreauth.Selector
	cache         *coreauth.SessionCache
	authAttribute string
}

func newCredentialAffinitySelector(fallback coreauth.Selector, ttl time.Duration, authAttribute string) *credentialAffinitySelector {
	if fallback == nil {
		fallback = &coreauth.RoundRobinSelector{}
	}
	if ttl <= 0 {
		ttl = time.Hour
	}
	return &credentialAffinitySelector{
		inner: coreauth.NewSessionAffinitySelectorWithConfig(coreauth.SessionAffinityConfig{
			Fallback: fallback,
			TTL:      ttl,
		}),
		fallback:      fallback,
		cache:         coreauth.NewSessionCache(ttl),
		authAttribute: strings.TrimSpace(authAttribute),
	}
}

func (s *credentialAffinitySelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	if opts.Metadata == nil {
		opts.Metadata = map[string]any{}
	}
	if !s.enabledForAuths(auths) {
		opts.Metadata[sessionAffinityStatusMetadataKey] = "disabled"
		return s.fallback.Pick(ctx, provider, model, opts, auths)
	}
	if responseID := previousResponseAffinityID(opts.OriginalRequest); responseID != "" {
		return s.pickResponseAffinity(provider, model, responseID, opts, auths)
	}
	return s.inner.Pick(ctx, provider, model, opts, auths)
}

func (s *credentialAffinitySelector) enabledForAuths(auths []*coreauth.Auth) bool {
	if s == nil || s.authAttribute == "" {
		return true
	}
	for _, auth := range auths {
		if auth == nil || auth.Attributes == nil {
			continue
		}
		value := strings.ToLower(strings.TrimSpace(auth.Attributes[s.authAttribute]))
		if value == "true" || value == "1" || value == "yes" || value == "on" {
			return true
		}
	}
	return false
}

func (s *credentialAffinitySelector) pickResponseAffinity(provider, model, responseID string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	cacheKey := responseAffinityCacheKey(provider, responseID, model)
	cachedAuthID, ok := s.cache.GetAndRefresh(cacheKey)
	if !ok {
		available := availableAffinityAuths(auths)
		if len(auths) == 1 && len(available) == 1 {
			opts.Metadata[sessionAffinityStatusMetadataKey] = "response_singleton"
			return available[0], nil
		}
		opts.Metadata[sessionAffinityStatusMetadataKey] = "response_miss"
		return nil, &coreauth.Error{
			Code:    "previous_response_affinity_missing",
			Message: "previous_response_id is not bound to an available upstream credential; resend the full conversation",
		}
	}

	available := availableAffinityAuths(auths)
	for _, auth := range available {
		if auth.ID != cachedAuthID {
			continue
		}
		opts.Metadata[sessionAffinityStatusMetadataKey] = "response_hit"
		return auth, nil
	}

	opts.Metadata[sessionAffinityStatusMetadataKey] = "response_unavailable"
	return nil, &coreauth.Error{
		Code:    "previous_response_affinity_unavailable",
		Message: "the upstream credential that owns previous_response_id is unavailable",
	}
}

func (s *credentialAffinitySelector) OnResult(res coreauth.Result) {
	if s == nil {
		return
	}
	if status, _ := res.Options.Metadata[sessionAffinityStatusMetadataKey].(string); status == "disabled" {
		return
	}
	if s.inner != nil {
		s.inner.OnResult(res)
	}
	if s.cache == nil || res.AuthID == "" || !res.Success {
		return
	}
	responseID, _ := res.Options.Metadata[responseAffinityIDMetadataKey].(string)
	responseID = strings.TrimSpace(responseID)
	if responseID == "" {
		return
	}
	ns := res.Provider
	if raw, ok := res.Options.Metadata[sessionAffinityProviderMetadataKey].(string); ok && strings.TrimSpace(raw) != "" {
		ns = strings.TrimSpace(raw)
	}
	nsModel := canonicalAffinityModel(res.Model)
	if raw, ok := res.Options.Metadata[sessionAffinityModelMetadataKey].(string); ok && strings.TrimSpace(raw) != "" {
		nsModel = canonicalAffinityModel(raw)
	}
	s.cache.Set(responseAffinityCacheKey(ns, responseID, nsModel), res.AuthID)
}

func (s *credentialAffinitySelector) InvalidateAuth(authID string) {
	if s == nil {
		return
	}
	if s.inner != nil {
		s.inner.InvalidateAuth(authID)
	}
	if s.cache != nil {
		s.cache.InvalidateAuth(authID)
	}
}

func (s *credentialAffinitySelector) Stop() {
	if s == nil {
		return
	}
	if s.inner != nil {
		s.inner.Stop()
	}
	if s.cache != nil {
		s.cache.Stop()
	}
}

func previousResponseAffinityID(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	id := strings.TrimSpace(gjson.GetBytes(payload, "previous_response_id").String())
	if id == "" || len(id) > 256 {
		return ""
	}
	return id
}

func responseAffinityCacheKey(provider, responseID, model string) string {
	return strings.TrimSpace(provider) + "::response:" + strings.TrimSpace(responseID) + "::" + canonicalAffinityModel(model)
}

func canonicalAffinityModel(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

func availableAffinityAuths(auths []*coreauth.Auth) []*coreauth.Auth {
	now := time.Now()
	out := make([]*coreauth.Auth, 0, len(auths))
	for _, auth := range auths {
		if auth == nil || auth.Disabled || auth.Unavailable || auth.Status != coreauth.StatusActive {
			continue
		}
		if !auth.NextRetryAfter.IsZero() && now.Before(auth.NextRetryAfter) {
			continue
		}
		out = append(out, auth)
	}
	return out
}

func recordResponseAffinityID(metadata map[string]any, payload []byte) {
	if metadata == nil || len(payload) == 0 {
		return
	}
	for _, path := range []string{"response.id", "id"} {
		responseID := strings.TrimSpace(gjson.GetBytes(payload, path).String())
		if responseID != "" {
			metadata[responseAffinityIDMetadataKey] = responseID
			return
		}
	}
}
