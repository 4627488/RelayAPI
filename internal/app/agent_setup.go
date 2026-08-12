package app

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"text/template"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

const agentSetupTTL = 5 * time.Minute
const agentSetupAssociatedData = "relayapi/agent-setup/v1"

var supportedSetupAgents = []string{"codex", "claude", "opencode"}
var supportedReasoningEfforts = []string{"minimal", "low", "medium", "high", "xhigh"}

//go:embed setup_templates/setup.sh
var agentSetupShellSource string

//go:embed setup_templates/setup.ps1
var agentSetupPowerShellSource string

var agentSetupShellTemplate = template.Must(template.New("setup.sh").Parse(agentSetupShellSource))
var agentSetupPowerShellTemplate = template.Must(template.New("setup.ps1").Parse(agentSetupPowerShellSource))

type agentSetupInput struct {
	KeyID                     string   `json:"key_id"`
	Agents                    []string `json:"agents"`
	Model                     string   `json:"model"`
	Models                    []string `json:"models,omitempty"`
	ReasoningEffort           string   `json:"reasoning_effort"`
	OpenCodeProtocol          string   `json:"opencode_protocol"`
	InstallMissing            bool     `json:"install_missing"`
	VerifyConnection          bool     `json:"verify_connection"`
	ClaudeGatewayDiscovery    bool     `json:"claude_gateway_discovery"`
	ClaudeDisableExtraTraffic bool     `json:"claude_disable_extra_traffic"`
}

type agentSetupClaim struct {
	TenantID string          `json:"tenant_id"`
	Expires  int64           `json:"exp"`
	Setup    agentSetupInput `json:"setup"`
}

type agentSetupTemplateData struct {
	EndpointBase64      string
	APIKeyBase64        string
	ClaudePatchBase64   string
	OpenCodePatchBase64 string
	CodexEditsBase64    string
	Codex               bool
	Claude              bool
	OpenCode            bool
	InstallMissing      bool
	VerifyConnection    bool
}

func normalizeAgentSetup(input *agentSetupInput) error {
	input.KeyID = strings.TrimSpace(input.KeyID)
	input.Model = strings.TrimSpace(input.Model)
	input.ReasoningEffort = strings.ToLower(strings.TrimSpace(input.ReasoningEffort))
	input.OpenCodeProtocol = strings.ToLower(strings.TrimSpace(input.OpenCodeProtocol))
	if input.KeyID == "" || input.Model == "" {
		return errors.New("请选择 API Key 和默认模型")
	}
	if len(input.Model) > 255 || strings.ContainsAny(input.Model, "\r\n\x00") {
		return errors.New("模型名称无效")
	}
	input.Models = normalizedModels(input.Models)
	if len(input.Models) == 0 {
		input.Models = []string{input.Model}
	}
	for _, model := range input.Models {
		if len(model) > 255 || strings.ContainsAny(model, "\r\n\x00") {
			return errors.New("OpenCode 模型列表包含无效名称")
		}
	}
	if !slices.Contains(input.Models, input.Model) {
		return errors.New("默认模型不在 OpenCode 模型列表中")
	}
	if input.ReasoningEffort == "" {
		input.ReasoningEffort = "high"
	}
	if !slices.Contains(supportedReasoningEfforts, input.ReasoningEffort) {
		return errors.New("Codex 推理强度无效")
	}
	if input.OpenCodeProtocol == "" {
		input.OpenCodeProtocol = "responses"
	}
	if input.OpenCodeProtocol != "responses" && input.OpenCodeProtocol != "chat" {
		return errors.New("OpenCode 协议必须是 responses 或 chat")
	}
	unique := make([]string, 0, len(input.Agents))
	for _, agent := range input.Agents {
		agent = strings.ToLower(strings.TrimSpace(agent))
		if !slices.Contains(supportedSetupAgents, agent) {
			return fmt.Errorf("不支持的客户端 %q", agent)
		}
		if !slices.Contains(unique, agent) {
			unique = append(unique, agent)
		}
	}
	if len(unique) == 0 {
		return errors.New("请至少选择一个客户端")
	}
	input.Agents = unique
	return nil
}

func (a *App) createAgentSetup(w http.ResponseWriter, r *http.Request) {
	var input agentSetupInput
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Models = nil
	if err := normalizeAgentSetup(&input); err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	tenantID := currentSession(r).TenantID
	plain, err := a.store.RevealKey(r.Context(), tenantID, input.KeyID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "密钥不存在")
		} else if errors.Is(err, store.ErrKeyNotRecoverable) {
			writeError(w, http.StatusConflict, "key_not_recoverable", "旧版密钥无法用于一键脚本，请新建密钥后重试")
		} else {
			writeError(w, http.StatusInternalServerError, "key_decrypt_failed", "密钥解密失败")
		}
		return
	}
	models, err := a.agentSetupModels(r.Context(), tenantID, plain)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "setup_failed", "无法读取 API Key 的可用模型")
		return
	}
	if !slices.Contains(models, input.Model) {
		writeError(w, http.StatusConflict, "model_unavailable", "默认模型已不可用，请刷新后重新选择")
		return
	}
	input.Models = models
	expires := time.Now().Add(agentSetupTTL)
	payload, err := json.Marshal(agentSetupClaim{TenantID: tenantID, Expires: expires.Unix(), Setup: input})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "setup_failed", "无法创建安装脚本")
		return
	}
	token, err := a.store.CreateAgentSetup(r.Context(), tenantID, payload, expires)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "setup_failed", "无法创建安装脚本")
		return
	}
	base := strings.TrimRight(a.cfg.PublicURL, "/") + "/setup/" + token
	setSensitiveNoStore(w)
	writeJSON(w, http.StatusCreated, map[string]any{
		"expires_at":               expires,
		"bash_command":             "curl -fsSL '" + base + "/install.sh' | bash",
		"bash_check_command":       "curl -fsSL '" + base + "/install.sh' | bash -s -- --check",
		"powershell_command":       "& ([scriptblock]::Create((irm '" + base + "/install.ps1')))",
		"powershell_check_command": "& ([scriptblock]::Create((irm '" + base + "/install.ps1'))) -Check",
	})
}

func (a *App) agentSetupScript(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	token := r.PathValue("token")
	var payload []byte
	var err error
	if len(token) <= 64 {
		payload, err = a.store.AgentSetup(r.Context(), token)
	} else {
		payload, err = a.openLegacyAgentSetup(token)
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "setup_not_found", "安装脚本不存在或已过期")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "setup_failed", "无法读取安装脚本")
		return
	}
	var claim agentSetupClaim
	if json.Unmarshal(payload, &claim) != nil || claim.Expires <= time.Now().Unix() || normalizeAgentSetup(&claim.Setup) != nil {
		writeError(w, http.StatusGone, "setup_expired", "安装脚本已过期，请回到接入向导重新生成")
		return
	}
	plain, err := a.store.RevealKey(r.Context(), claim.TenantID, claim.Setup.KeyID)
	if err != nil {
		writeError(w, http.StatusGone, "setup_key_unavailable", "安装脚本使用的密钥已不可用，请重新生成")
		return
	}
	platform := "bash"
	if strings.HasSuffix(r.URL.Path, ".ps1") {
		platform = "powershell"
	}
	data, err := buildAgentSetupTemplateData(a.cfg.PublicURL, plain, claim.Setup, platform)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "setup_failed", "无法渲染安装脚本")
		return
	}
	if platform == "powershell" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `inline; filename="relayapi-setup.ps1"`)
		if r.Method != http.MethodHead {
			_ = agentSetupPowerShellTemplate.Execute(w, data)
		}
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="relayapi-setup.sh"`)
	if r.Method != http.MethodHead {
		_ = agentSetupShellTemplate.Execute(w, data)
	}
}

func (a *App) openLegacyAgentSetup(token string) ([]byte, error) {
	sealed, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, store.ErrNotFound
	}
	payload, err := a.setupBox.Open(sealed, agentSetupAssociatedData)
	if err != nil {
		return nil, store.ErrNotFound
	}
	return payload, nil
}

func setSensitiveNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (a *App) agentSetupModels(ctx context.Context, tenantID, plain string) ([]string, error) {
	key, err := a.store.ResolveKey(ctx, plain)
	if err != nil {
		return nil, err
	}
	children, err := a.store.ListChildSubscriptions(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	inherited := make([]string, 0)
	for _, child := range children {
		if !child.Enabled || child.StartsAt.After(now) || child.ExpiresAt != nil && !child.ExpiresAt.After(now) {
			continue
		}
		parent, err := a.store.GetParentSubscription(ctx, child.ParentSubscriptionID)
		if err != nil {
			return nil, err
		}
		models, _ := effectiveSubscriptionModels(parent, child)
		inherited = append(inherited, models...)
	}
	models := append(append([]string(nil), key.TenantModels...), inherited...)
	if len(key.ModelAllowlist) > 0 {
		models = append(models, key.ModelAllowlist...)
	}
	models = normalizedModels(models)
	allowedModels := make([]string, 0, len(models)+len(key.ModelAliases))
	for _, model := range models {
		if key.AllowsModel(model) {
			allowedModels = append(allowedModels, model)
		}
	}
	for _, alias := range key.ModelAliases {
		if key.AllowsModel(alias.Model) {
			allowedModels = append(allowedModels, alias.Alias)
		}
	}
	return normalizedModels(allowedModels), nil
}

func buildAgentSetupTemplateData(endpoint, apiKey string, input agentSetupInput, platform string) (agentSetupTemplateData, error) {
	endpoint = strings.TrimRight(endpoint, "/")
	keyPath := "~/.config/relayapi/api-key"
	claudeHelper := `cat ~/.config/relayapi/api-key`
	codexAuth := map[string]any{"command": "sh", "args": []string{"-c", `cat "$HOME/.config/relayapi/api-key"`}}
	if platform == "powershell" {
		keyPath = "~/.config/relayapi/api-key"
		claudeHelper = `powershell -NoProfile -Command "$p=Join-Path $HOME '.config\relayapi\api-key'; [IO.File]::ReadAllText($p)"`
		codexAuth = map[string]any{"command": "powershell", "args": []string{"-NoProfile", "-Command", `$p=Join-Path $HOME '.config\relayapi\api-key'; [IO.File]::ReadAllText($p)`}}
	}
	claudeEnv := map[string]string{
		"ANTHROPIC_BASE_URL":             endpoint,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   input.Model,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": input.Model,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  input.Model,
		"ANTHROPIC_MODEL":                input.Model,
		"ANTHROPIC_SMALL_FAST_MODEL":     input.Model,
	}
	if input.ClaudeGatewayDiscovery && !input.ClaudeDisableExtraTraffic {
		claudeEnv["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
	}
	if input.ClaudeDisableExtraTraffic {
		claudeEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
	}
	claudePatch := map[string]any{"apiKeyHelper": claudeHelper, "env": claudeEnv}

	npmPackage := "@ai-sdk/openai"
	if input.OpenCodeProtocol == "chat" {
		npmPackage = "@ai-sdk/openai-compatible"
	}
	openCodeModelIDs := input.Models
	if len(openCodeModelIDs) == 0 {
		openCodeModelIDs = []string{input.Model}
	}
	openCodeModels := make(map[string]any, len(openCodeModelIDs))
	for _, model := range openCodeModelIDs {
		openCodeModels[model] = map[string]any{"name": model}
	}
	openCodePatch := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"model":   "relayapi/" + input.Model,
		"provider": map[string]any{"relayapi": map[string]any{
			"npm": npmPackage, "name": "RelayAPI",
			"options": map[string]any{"baseURL": endpoint + "/v1", "apiKey": "{file:" + keyPath + "}"},
			"models":  openCodeModels,
		}},
	}
	codexEdits := []map[string]any{
		{"keyPath": "model_provider", "mergeStrategy": "replace", "value": "relayapi"},
		{"keyPath": "model", "mergeStrategy": "replace", "value": input.Model},
		{"keyPath": "model_reasoning_effort", "mergeStrategy": "replace", "value": input.ReasoningEffort},
		{"keyPath": "model_providers.relayapi.name", "mergeStrategy": "replace", "value": "RelayAPI"},
		{"keyPath": "model_providers.relayapi.base_url", "mergeStrategy": "replace", "value": endpoint + "/v1"},
		{"keyPath": "model_providers.relayapi.auth", "mergeStrategy": "replace", "value": codexAuth},
		{"keyPath": "model_providers.relayapi.wire_api", "mergeStrategy": "replace", "value": "responses"},
		{"keyPath": "model_providers.relayapi.supports_websockets", "mergeStrategy": "replace", "value": true},
		{"keyPath": "features.apps", "mergeStrategy": "replace", "value": false},
	}
	encodeJSON := func(value any) (string, error) {
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		return base64.StdEncoding.EncodeToString(encoded), nil
	}
	claude, err := encodeJSON(claudePatch)
	if err != nil {
		return agentSetupTemplateData{}, err
	}
	opencode, err := encodeJSON(openCodePatch)
	if err != nil {
		return agentSetupTemplateData{}, err
	}
	codex, err := encodeJSON(codexEdits)
	if err != nil {
		return agentSetupTemplateData{}, err
	}
	return agentSetupTemplateData{
		EndpointBase64: base64.StdEncoding.EncodeToString([]byte(endpoint)), APIKeyBase64: base64.StdEncoding.EncodeToString([]byte(apiKey)),
		ClaudePatchBase64: claude, OpenCodePatchBase64: opencode, CodexEditsBase64: codex,
		Codex: slices.Contains(input.Agents, "codex"), Claude: slices.Contains(input.Agents, "claude"),
		OpenCode: slices.Contains(input.Agents, "opencode"), InstallMissing: input.InstallMissing,
		VerifyConnection: input.VerifyConnection,
	}, nil
}
