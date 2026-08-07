package dataplane

import (
	"fmt"
	"net/url"
	"strings"
)

// Protocol is Relay's stable protocol vocabulary. Upstream SDK types stay
// behind Translator so routing and credentials do not depend on CPA internals.
type Protocol string

const (
	ProtocolOpenAI       Protocol = "openai"
	ProtocolResponses    Protocol = "openai-response"
	ProtocolClaude       Protocol = "claude"
	ProtocolGemini       Protocol = "gemini"
	ProtocolCodex        Protocol = "codex"
	ProtocolAntigravity  Protocol = "antigravity"
	ProtocolInteractions Protocol = "interactions"
)

func DetectProtocol(path string) (Protocol, error) {
	clean := strings.ToLower(strings.TrimSpace(path))
	switch {
	case strings.HasPrefix(clean, "/backend-api/codex/"):
		return ProtocolCodex, nil
	case clean == "/v1/messages" || strings.HasPrefix(clean, "/v1/messages/"):
		return ProtocolClaude, nil
	case clean == "/v1/chat/completions" || strings.HasPrefix(clean, "/v1/chat/completions/"):
		return ProtocolOpenAI, nil
	case clean == "/v1/responses" || strings.HasPrefix(clean, "/v1/responses/") ||
		clean == "/openai/v1/responses" || strings.HasPrefix(clean, "/openai/v1/responses/"):
		return ProtocolResponses, nil
	case strings.HasPrefix(clean, "/v1beta/models/"):
		return ProtocolGemini, nil
	default:
		return "", fmt.Errorf("unsupported API path %q", path)
	}
}

func ProviderProtocol(provider string) (Protocol, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codex", "xai", "grok":
		return ProtocolCodex, nil
	case "claude", "anthropic":
		return ProtocolClaude, nil
	case "gemini", "vertex", "aistudio":
		return ProtocolGemini, nil
	case "antigravity":
		return ProtocolAntigravity, nil
	case "interactions":
		return ProtocolInteractions, nil
	case "openai", "openai-compatible", "kimi":
		return ProtocolOpenAI, nil
	default:
		return "", fmt.Errorf("unsupported provider %q", provider)
	}
}

// RoutePlan is the complete immutable decision consumed by the hot path.
// Building it may use storage; executing it must not.
type RoutePlan struct {
	Provider     string
	CredentialID string
	Model        string
	Endpoint     *url.URL
	Inbound      Protocol
	Upstream     Protocol
	Stream       bool
}

func (p RoutePlan) Validate() error {
	if strings.TrimSpace(p.Provider) == "" || strings.TrimSpace(p.CredentialID) == "" || strings.TrimSpace(p.Model) == "" {
		return fmt.Errorf("route plan requires provider, credential and model")
	}
	if p.Endpoint == nil || p.Endpoint.Scheme == "" || p.Endpoint.Host == "" {
		return fmt.Errorf("route plan requires an absolute endpoint")
	}
	if p.Inbound == "" || p.Upstream == "" {
		return fmt.Errorf("route plan requires inbound and upstream protocols")
	}
	return nil
}
