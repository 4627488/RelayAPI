package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
)

func TestNormalizeAgentSetup(t *testing.T) {
	input := agentSetupInput{
		KeyID: " key-1 ", Agents: []string{"Codex", "codex", "claude"}, Model: " gpt-5.6-sol ",
	}
	if err := normalizeAgentSetup(&input); err != nil {
		t.Fatal(err)
	}
	if input.KeyID != "key-1" || input.Model != "gpt-5.6-sol" || input.ReasoningEffort != "high" || input.OpenCodeProtocol != "responses" {
		t.Fatalf("normalized input = %+v", input)
	}
	if strings.Join(input.Models, ",") != "gpt-5.6-sol" {
		t.Fatalf("models = %v", input.Models)
	}
	if strings.Join(input.Agents, ",") != "codex,claude" {
		t.Fatalf("agents = %v", input.Agents)
	}

	invalid := []agentSetupInput{
		{KeyID: "", Agents: []string{"codex"}, Model: "gpt"},
		{KeyID: "key", Agents: nil, Model: "gpt"},
		{KeyID: "key", Agents: []string{"unknown"}, Model: "gpt"},
		{KeyID: "key", Agents: []string{"codex"}, Model: "bad\nmodel"},
		{KeyID: "key", Agents: []string{"codex"}, Model: "gpt", ReasoningEffort: "maximum"},
		{KeyID: "key", Agents: []string{"opencode"}, Model: "gpt", OpenCodeProtocol: "legacy"},
		{KeyID: "key", Agents: []string{"opencode"}, Model: "gpt", Models: []string{"other"}},
	}
	for index := range invalid {
		if err := normalizeAgentSetup(&invalid[index]); err == nil {
			t.Fatalf("invalid input %d was accepted: %+v", index, invalid[index])
		}
	}
}

func TestBuildAgentSetupConfiguration(t *testing.T) {
	input := agentSetupInput{
		KeyID: "key-1", Agents: []string{"codex", "claude", "opencode"}, Model: "gpt-5.6-sol",
		Models:          []string{"gpt-5.6-sol", "claude-sonnet-4-6"},
		ReasoningEffort: "xhigh", OpenCodeProtocol: "responses", InstallMissing: true,
		VerifyConnection: true, ClaudeGatewayDiscovery: true,
	}
	data, err := buildAgentSetupTemplateData("https://relay.example/", "relay_super_secret", input, "bash")
	if err != nil {
		t.Fatal(err)
	}
	if !data.Codex || !data.Claude || !data.OpenCode || !data.InstallMissing || !data.VerifyConnection {
		t.Fatalf("template flags = %+v", data)
	}

	var claude map[string]any
	decodeSetupJSON(t, data.ClaudePatchBase64, &claude)
	env := claude["env"].(map[string]any)
	if env["ANTHROPIC_BASE_URL"] != "https://relay.example" || env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] != "1" {
		t.Fatalf("claude patch = %#v", claude)
	}
	if !strings.Contains(claude["apiKeyHelper"].(string), "api-key") {
		t.Fatalf("claude helper = %#v", claude["apiKeyHelper"])
	}

	var opencode map[string]any
	decodeSetupJSON(t, data.OpenCodePatchBase64, &opencode)
	provider := opencode["provider"].(map[string]any)["relayapi"].(map[string]any)
	if provider["npm"] != "@ai-sdk/openai" || opencode["model"] != "relayapi/gpt-5.6-sol" {
		t.Fatalf("opencode patch = %#v", opencode)
	}
	models := provider["models"].(map[string]any)
	if len(models) != 2 || models["gpt-5.6-sol"] == nil || models["claude-sonnet-4-6"] == nil {
		t.Fatalf("opencode models = %#v", models)
	}

	var edits []map[string]any
	decodeSetupJSON(t, data.CodexEditsBase64, &edits)
	values := make(map[string]any, len(edits))
	for _, edit := range edits {
		values[edit["keyPath"].(string)] = edit["value"]
	}
	if values["model_providers.relayapi.wire_api"] != "responses" || values["model_providers.relayapi.supports_websockets"] != true || values["model_reasoning_effort"] != "xhigh" {
		t.Fatalf("codex edits = %#v", values)
	}
}

func TestAgentSetupScriptsRenderAndParse(t *testing.T) {
	input := agentSetupInput{
		KeyID: "key", Agents: []string{"codex", "claude", "opencode"}, Model: "model",
		ReasoningEffort: "high", OpenCodeProtocol: "chat", InstallMissing: true, VerifyConnection: true,
	}
	for _, platform := range []string{"bash", "powershell"} {
		data, err := buildAgentSetupTemplateData("https://relay.example", "relay_plaintext_secret", input, platform)
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		selected := agentSetupShellTemplate
		if platform == "powershell" {
			selected = agentSetupPowerShellTemplate
		}
		if err := selected.Execute(&output, data); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(output.Bytes(), []byte("relay_plaintext_secret")) {
			t.Fatal("rendered script contains an unencoded plaintext API key")
		}
		if !bytes.Contains(output.Bytes(), []byte("relayapi-backup")) || !bytes.Contains(output.Bytes(), []byte("/v1/models")) {
			t.Fatalf("%s script is missing backup or verification logic", platform)
		}
		if platform == "powershell" {
			for _, unsafe := range []string{"$message.id", "$message.error", "$message.result", "$result.status"} {
				if bytes.Contains(output.Bytes(), []byte(unsafe)) {
					t.Fatalf("powershell script directly reads optional JSON property %q under strict mode", unsafe)
				}
			}
			if !bytes.Contains(output.Bytes(), []byte("$message.PSObject.Properties['result']")) {
				t.Fatal("powershell script is missing strict-mode-safe JSON-RPC result handling")
			}
		}
		assertScriptParses(t, platform, output.Bytes())
	}
}

func TestOpenCodeSetupReplacesManagedModelsAndResolvesProviderFilters(t *testing.T) {
	binary, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	configDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	opencodePath := filepath.Join(binDir, "opencode")
	if err := os.WriteFile(opencodePath, []byte("#!/usr/bin/env bash\nprintf '1.18.16\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(configDir, "opencode.json")
	existing := `{
  "theme": "system",
  "disabled_providers": ["relayapi", "anthropic"],
  "enabled_providers": ["openai"],
  "provider": {
    "relayapi": {
      "models": {
        "stale-model": {"name": "Stale"},
        "gpt-5.6-sol": {"name": "Old name"}
      }
    }
  }
}`
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	input := agentSetupInput{
		KeyID: "key", Agents: []string{"opencode"}, Model: "gpt-5.6-sol",
		Models: []string{"gpt-5.6-sol", "claude-sonnet-4-6"}, OpenCodeProtocol: "responses",
	}
	data, err := buildAgentSetupTemplateData("https://relay.example", "relay_secret", input, "bash")
	if err != nil {
		t.Fatal(err)
	}
	var rendered bytes.Buffer
	if err := agentSetupShellTemplate.Execute(&rendered, data); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(home, "setup.sh")
	if err := os.WriteFile(scriptPath, rendered.Bytes(), 0o700); err != nil {
		t.Fatal(err)
	}
	homeForShell := filepath.ToSlash(home)
	scriptForShell := filepath.ToSlash(scriptPath)
	if runtime.GOOS == "windows" {
		homeForShell = wslPath(t, home)
		scriptForShell = wslPath(t, scriptPath)
	}
	command := exec.Command(binary, scriptForShell)
	command.Env = append(os.Environ(), "HOME="+homeForShell, "XDG_CONFIG_HOME="+homeForShell+"/.config")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run setup: %v\n%s", err, output)
	}
	payload, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(payload, &config); err != nil {
		t.Fatal(err)
	}
	if config["theme"] != "system" {
		t.Fatalf("unrelated config was not preserved: %#v", config)
	}
	provider := config["provider"].(map[string]any)["relayapi"].(map[string]any)
	models := provider["models"].(map[string]any)
	if len(models) != 2 || models["stale-model"] != nil || models["gpt-5.6-sol"] == nil || models["claude-sonnet-4-6"] == nil {
		t.Fatalf("managed models were not replaced: %#v", models)
	}
	if values := stringSlice(config["disabled_providers"]); strings.Join(values, ",") != "anthropic" {
		t.Fatalf("disabled providers = %v", values)
	}
	if values := stringSlice(config["enabled_providers"]); strings.Join(values, ",") != "openai,relayapi" {
		t.Fatalf("enabled providers = %v", values)
	}
}

func wslPath(t *testing.T, path string) string {
	t.Helper()
	output, err := exec.Command("wsl.exe", "wslpath", "-a", "-u", path).CombinedOutput()
	if err != nil {
		t.Skipf("WSL path conversion unavailable: %v (%s)", err, output)
	}
	return strings.TrimSpace(string(output))
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func TestExpiredAgentSetupTokenIsSealedAndNotCacheable(t *testing.T) {
	box, err := identity.NewSecretBox("agent-setup-test-encryption-secret")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(agentSetupClaim{
		TenantID: "tenant-secret", Expires: time.Now().Add(-time.Minute).Unix(),
		Setup: agentSetupInput{KeyID: "key-secret", Agents: []string{"codex"}, Model: "gpt"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal(payload, agentSetupAssociatedData)
	if err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(sealed)
	if strings.Contains(token, "tenant-secret") || strings.Contains(token, "key-secret") {
		t.Fatal("setup token leaked claim identifiers")
	}

	request := httptest.NewRequest("GET", "/setup/placeholder/install.sh", nil)
	request.SetPathValue("token", token)
	recorder := httptest.NewRecorder()
	app := App{setupBox: box}
	app.agentSetupScript(recorder, request)
	if recorder.Code != 410 {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Referrer-Policy") != "no-referrer" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("sensitive headers = %#v", recorder.Header())
	}
}

func decodeSetupJSON(t *testing.T, encoded string, target any) {
	t.Helper()
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatal(err)
	}
}

func assertScriptParses(t *testing.T, platform string, source []byte) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "setup.sh")
	if platform == "powershell" {
		path = filepath.Join(dir, "setup.ps1")
	}
	if err := os.WriteFile(path, source, 0o600); err != nil {
		t.Fatal(err)
	}
	if platform == "bash" {
		binary, err := exec.LookPath("bash")
		if err != nil {
			t.Log("bash unavailable; syntax validation skipped")
			return
		}
		command := exec.Command(binary, "-n")
		command.Stdin = bytes.NewReader(source)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("bash syntax: %v\n%s", err, output)
		}
		return
	}
	binary, err := exec.LookPath("powershell")
	if err != nil {
		t.Log("powershell unavailable; syntax validation skipped")
		return
	}
	command := `$null = [scriptblock]::Create([IO.File]::ReadAllText('` + strings.ReplaceAll(path, `'`, `''`) + `'))`
	if output, err := exec.Command(binary, "-NoProfile", "-NonInteractive", "-Command", command).CombinedOutput(); err != nil {
		t.Fatalf("powershell syntax: %v\n%s", err, output)
	}
}
