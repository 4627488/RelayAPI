package relaybridge

import "strings"

// NormalizeProvider is the built-in CPA executor boundary shared by Relay's
// credential policy and the bridge. Unknown types must never silently become
// OpenAI-compatible executors.
func NormalizeProvider(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "codex", "claude", "gemini", "gemini-interactions", "vertex", "aistudio", "antigravity", "kimi", "xai", "devin", "meta", "openai", "openai-compatibility":
		return strings.ToLower(strings.TrimSpace(value)), true
	case "anthropic":
		return "claude", true
	case "gemini-api-key":
		return "gemini", true
	case "interactions", "gemini-interactions-api-key":
		return "gemini-interactions", true
	case "kimi-ai", "kimi.ai", "kimi.com":
		return "kimi", true
	case "x.ai", "x-ai", "grok":
		return "xai", true
	case "muse":
		return "meta", true
	case "openai-compatible":
		return "openai-compatibility", true
	default:
		return "", false
	}
}

func SupportsOAuth(provider string) bool {
	provider, _ = NormalizeProvider(provider)
	switch provider {
	case "codex", "claude", "antigravity", "kimi", "xai", "devin", "meta":
		return true
	default:
		return false
	}
}
