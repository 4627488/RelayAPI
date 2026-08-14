package app

import (
	"strings"
	"testing"
)

func TestIdentifyClientUserAgent(t *testing.T) {
	tests := []struct {
		userAgent   string
		wantName    string
		wantVersion string
	}{
		{"codex-tui/0.146.0 (Ubuntu 24.4.0; x86_64) xterm-256color (codex-tui; 0.146.0)", "Codex CLI", "0.146.0"},
		{"Codex Desktop/0.147.0-alpha.6.5 (Windows 10.0.26200; x86_64)", "Codex Desktop", "0.147.0-alpha.6.5"},
		{"codex_vscode/0.147.0-alpha.6.5 (Windows 10.0.26200; x86_64)", "Codex VS Code", "0.147.0-alpha.6.5"},
		{"codex-browser-use/0.142.0-alpha.1 (Windows 10.0.26200; x86_64)", "Codex Browser Use", "0.142.0-alpha.1"},
		{"deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)", "DeepSeek Harness", "0.1.0-rc.6"},
		{"opencode/1.18.14 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14", "OpenCode", "1.18.14"},
		{"github-copilot/1.300.0", "GitHub Copilot", "1.300.0"},
		{"ai-sdk/provider-utils/4.0.23", "Vercel AI SDK", "4.0.23"},
		{"OpenAI/JS 4.104.0", "OpenAI JavaScript SDK", "4.104.0"},
		{"WorkBuddy/5.3.3 WorkBuddy/5.3.3 CLI/2.115.0", "WorkBuddy", "5.3.3"},
		{"Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0", "Microsoft Edge", "150.0.0.0"},
		{"node", "Node.js", ""},
		{"node/", "Node.js", ""},
		{"custom-gateway/7", "Unknown client", ""},
		{"", "Unknown client", ""},
	}
	for _, test := range tests {
		t.Run(test.wantName+"_"+test.wantVersion, func(t *testing.T) {
			got := identifyClientUserAgent(test.userAgent)
			if got.Name != test.wantName || got.Version != test.wantVersion {
				t.Fatalf("identifyClientUserAgent(%q) = %#v, want name=%q version=%q", test.userAgent, got, test.wantName, test.wantVersion)
			}
			if test.userAgent != "" && got.UserAgent != test.userAgent {
				t.Fatalf("stored user agent = %q, want %q", got.UserAgent, test.userAgent)
			}
		})
	}
}

func TestIdentifyClientUserAgentBoundsRawValue(t *testing.T) {
	value := strings.Repeat("a", maxStoredUserAgentBytes-1) + "界"
	got := identifyClientUserAgent(value)
	if len(got.UserAgent) > maxStoredUserAgentBytes {
		t.Fatalf("stored user agent length = %d", len(got.UserAgent))
	}
	if !strings.HasSuffix(got.UserAgent, "a") {
		t.Fatalf("stored user agent split a UTF-8 rune: %q", got.UserAgent[len(got.UserAgent)-4:])
	}
}
