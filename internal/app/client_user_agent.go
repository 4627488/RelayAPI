package app

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxStoredUserAgentBytes = 2048

type clientIdentity struct {
	Name      string
	Version   string
	UserAgent string
}

type clientUserAgentRule struct {
	name    string
	pattern *regexp.Regexp
}

// Order matters: product-specific clients must win over SDK/runtime tokens
// that may also appear later in the same User-Agent string.
var clientUserAgentRules = []clientUserAgentRule{
	{"Codex Browser Use", regexp.MustCompile(`(?i)\bcodex-browser-use/([^\s;()]+)`)},
	{"Codex VS Code", regexp.MustCompile(`(?i)\bcodex_vscode/([^\s;()]+)`)},
	{"Codex Desktop", regexp.MustCompile(`(?i)\bcodex[ _-]desktop/([^\s;()]+)`)},
	{"Codex CLI", regexp.MustCompile(`(?i)\bcodex-tui/([^\s;()]+)`)},
	{"Codex CLI", regexp.MustCompile(`(?i)\bcodex_cli_rs/([^\s;()]+)`)},
	{"Codex CLI", regexp.MustCompile(`(?i)\bcodex-cli/([^\s;()]+)`)},
	{"Claude Code VS Code", regexp.MustCompile(`(?i)\bclaude-cli/([^\s;()]+).*\bclaude-vscode\b`)},
	{"Claude Code", regexp.MustCompile(`(?i)\bclaude-cli/([^\s;()]+)`)},
	{"Claude Code", regexp.MustCompile(`(?i)\bclaude-code/([^\s;()]+)`)},
	{"DeepSeek Harness", regexp.MustCompile(`(?i)\bdeepseek-harness/([^\s;()]+)`)},
	{"OpenCode", regexp.MustCompile(`(?i)\bopencode/([^\s;()]+)`)},
	{"WorkBuddy", regexp.MustCompile(`(?i)\bworkbuddy/([^\s;()]+)`)},
	{"ChatGPT", regexp.MustCompile(`(?i)\bchatgpt/([^\s;()]+)`)},
	{"Qwen Code", regexp.MustCompile(`(?i)\bqwen-code/([^\s;()]+)`)},
	{"GitHub Copilot", regexp.MustCompile(`(?i)\b(?:github-copilot|githubcopilotchat)/([^\s;()]+)`)},
	{"Cursor", regexp.MustCompile(`(?i)\bcursor/([^\s;()]+)`)},
	{"Windsurf", regexp.MustCompile(`(?i)\bwindsurf/([^\s;()]+)`)},
	{"Cline", regexp.MustCompile(`(?i)\bcline/([^\s;()]+)`)},
	{"Roo Code", regexp.MustCompile(`(?i)\b(?:roo-code|roocode)/([^\s;()]+)`)},
	{"Kilo Code", regexp.MustCompile(`(?i)\b(?:kilo-code|kilocode)/([^\s;()]+)`)},
	{"Continue", regexp.MustCompile(`(?i)\bcontinue(?:-dev)?/([^\s;()]+)`)},
	{"Aider", regexp.MustCompile(`(?i)\baider/([^\s;()]+)`)},
	{"Goose", regexp.MustCompile(`(?i)\bgoose/([^\s;()]+)`)},
	{"Amp", regexp.MustCompile(`(?i)\bamp/([^\s;()]+)`)},
	{"Amazon Q", regexp.MustCompile(`(?i)\bamazon-q/([^\s;()]+)`)},
	{"Open WebUI", regexp.MustCompile(`(?i)\bopen-webui/([^\s;()]+)`)},
	{"Cherry Studio", regexp.MustCompile(`(?i)\bcherry(?:-|\s)?studio/([^\s;()]+)`)},
	{"Chatbox", regexp.MustCompile(`(?i)\bchatbox/([^\s;()]+)`)},
	{"LobeChat", regexp.MustCompile(`(?i)\blobe(?:-|\s)?chat/([^\s;()]+)`)},
	{"NextChat", regexp.MustCompile(`(?i)\b(?:nextchat|chatgpt-next-web)/([^\s;()]+)`)},
	{"AnythingLLM", regexp.MustCompile(`(?i)\banythingllm/([^\s;()]+)`)},
	{"Dify", regexp.MustCompile(`(?i)\bdify/([^\s;()]+)`)},
	{"Flowise", regexp.MustCompile(`(?i)\bflowise/([^\s;()]+)`)},
	{"n8n", regexp.MustCompile(`(?i)\bn8n/([^\s;()]+)`)},
	{"LiteLLM", regexp.MustCompile(`(?i)\blitellm/([^\s;()]+)`)},
	{"LangChain", regexp.MustCompile(`(?i)\blangchain(?:-[a-z]+)?/([^\s;()]+)`)},
	{"LlamaIndex", regexp.MustCompile(`(?i)\bllama[-_]?index/([^\s;()]+)`)},
	{"Semantic Kernel", regexp.MustCompile(`(?i)\bsemantic-kernel/([^\s;()]+)`)},
	{"Vercel AI SDK", regexp.MustCompile(`(?i)\bai-sdk(?:/[^\s;()]+)?/([^\s;()]+)`)},
	{"OpenAI JavaScript SDK", regexp.MustCompile(`(?i)\bopenai/js\s+([^\s;()]+)`)},
	{"OpenAI Python SDK", regexp.MustCompile(`(?i)\b(?:openai/python\s+|openai-python/)([^\s;()]+)`)},
	{"OpenAI Go SDK", regexp.MustCompile(`(?i)\b(?:openai/go\s+|openai-go/)([^\s;()]+)`)},
	{"OpenAI Java SDK", regexp.MustCompile(`(?i)\b(?:openai/java\s+|openai-java/)([^\s;()]+)`)},
	{"OpenAI .NET SDK", regexp.MustCompile(`(?i)\b(?:openai/dotnet\s+|openai-dotnet/)([^\s;()]+)`)},
	{"Ollama", regexp.MustCompile(`(?i)\bollama/([^\s;()]+)`)},
	{"Microsoft Edge", regexp.MustCompile(`(?i)\bedg/([^\s;()]+)`)},
	{"Google Chrome", regexp.MustCompile(`(?i)\bchrome/([^\s;()]+)`)},
	{"Mozilla Firefox", regexp.MustCompile(`(?i)\bfirefox/([^\s;()]+)`)},
	{"Apple Safari", regexp.MustCompile(`(?i)\bversion/([^\s;()]+).*\bsafari/`)},
	{"curl", regexp.MustCompile(`(?i)\bcurl/([^\s;()]+)`)},
	{"Wget", regexp.MustCompile(`(?i)\bwget/([^\s;()]+)`)},
	{"Python urllib", regexp.MustCompile(`(?i)\bpython-urllib/([^\s;()]+)`)},
}

func identifyClientUserAgent(raw string) clientIdentity {
	userAgent := boundedUserAgent(raw)
	if userAgent == "" {
		return clientIdentity{Name: "Unknown client"}
	}
	for _, rule := range clientUserAgentRules {
		matches := rule.pattern.FindStringSubmatch(userAgent)
		if len(matches) >= 2 {
			return clientIdentity{Name: rule.name, Version: strings.TrimSpace(matches[1]), UserAgent: userAgent}
		}
	}
	lower := strings.ToLower(userAgent)
	switch {
	case lower == "node" || strings.HasPrefix(lower, "node/"):
		return clientIdentity{Name: "Node.js", Version: slashVersion(userAgent), UserAgent: userAgent}
	case strings.HasPrefix(lower, "postmanruntime/"):
		return clientIdentity{Name: "Postman", Version: slashVersion(userAgent), UserAgent: userAgent}
	case strings.Contains(lower, "mozilla/5.0"):
		return clientIdentity{Name: "Web browser", UserAgent: userAgent}
	default:
		return clientIdentity{Name: "Unknown client", UserAgent: userAgent}
	}
}

func boundedUserAgent(value string) string {
	value = strings.ToValidUTF8(strings.TrimSpace(value), "\uFFFD")
	if len(value) <= maxStoredUserAgentBytes {
		return value
	}
	end := maxStoredUserAgentBytes
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end]
}

func slashVersion(value string) string {
	_, version, ok := strings.Cut(strings.TrimSpace(value), "/")
	if !ok {
		return ""
	}
	fields := strings.Fields(version)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
