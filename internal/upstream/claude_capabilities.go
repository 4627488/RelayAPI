package upstream

// NativeClaudeCapabilities describes an audited native Messages route. A
// model's name alone says nothing about a gateway's tool-search transport.
type NativeClaudeCapabilities struct {
	Model      string
	ToolSearch bool
}

type ClaudeCapabilityProvider interface {
	NativeClaudeCapabilities(string) (NativeClaudeCapabilities, bool)
}
