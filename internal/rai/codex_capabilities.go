package rai

// CodexCapabilities is the gateway's versioned, provider-wide contract. These
// capabilities apply to every model a user can select during the session.
// Missing or newer contracts fail closed rather than assuming native support.
type CodexCapabilities struct {
	Version             int  `json:"version"`
	WebSockets          bool `json:"supports_websockets"`
	StandaloneWebSearch bool `json:"supports_standalone_web_search"`
	RemoteCompaction    bool `json:"remote_compaction_v2"`
}

const codexAuthTimeoutMS int64 = 30000
const codexAuthRefreshMS int64 = 60000

func effectiveCodexCapabilities(c *CodexCapabilities) CodexCapabilities {
	if c == nil || c.Version != 1 {
		return CodexCapabilities{Version: 1}
	}
	return *c
}
