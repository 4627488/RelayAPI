package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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
		assertScriptParses(t, platform, output.Bytes())
	}
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
