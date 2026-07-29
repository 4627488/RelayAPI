package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type providerAccount struct {
	ID            string   `json:"id"`
	AuthIndex     string   `json:"auth_index,omitempty"`
	Name          string   `json:"name"`
	Provider      string   `json:"provider"`
	Type          string   `json:"type,omitempty"`
	Email         string   `json:"email,omitempty"`
	Label         string   `json:"label,omitempty"`
	Status        string   `json:"status,omitempty"`
	StatusMessage string   `json:"status_message,omitempty"`
	Disabled      bool     `json:"disabled"`
	Unavailable   bool     `json:"unavailable,omitempty"`
	Success       int64    `json:"success,omitempty"`
	Failed        int64    `json:"failed,omitempty"`
	Source        string   `json:"source"`
	ConfigPath    string   `json:"config_path,omitempty"`
	ConfigIndex   *int     `json:"config_index,omitempty"`
	BaseURL       string   `json:"base_url,omitempty"`
	Prefix        string   `json:"prefix,omitempty"`
	Models        []string `json:"models"`
	KeyCount      int      `json:"key_count,omitempty"`
	CanInspect    bool     `json:"can_inspect"`
	CanToggle     bool     `json:"can_toggle"`
	CanDelete     bool     `json:"can_delete"`
}

var providerConfigDefinitions = []struct {
	path     string
	provider string
	kind     string
}{
	{"gemini-api-key", "Google Gemini", "API Key"},
	{"interactions-api-key", "Google Interactions", "API Key"},
	{"claude-api-key", "Anthropic Claude", "API Key"},
	{"codex-api-key", "OpenAI / Codex", "API Key"},
	{"xai-api-key", "xAI", "API Key"},
	{"vertex-api-key", "Vertex-compatible", "API Key"},
	{"openai-compatibility", "OpenAI-compatible", "兼容端点"},
}

func decodeProviderAccounts(payload []byte) ([]providerAccount, error) {
	var response struct {
		Files []map[string]any `json:"files"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, err
	}
	result := make([]providerAccount, 0, len(response.Files))
	for _, item := range response.Files {
		account := providerAccount{
			ID: stringValue(item["id"]), AuthIndex: stringValue(item["auth_index"]),
			Name: stringValue(item["name"]), Provider: stringValue(item["provider"]),
			Type: stringValue(item["type"]), Email: stringValue(item["email"]),
			Label: stringValue(item["label"]), Status: stringValue(item["status"]),
			StatusMessage: stringValue(item["status_message"]), Disabled: boolValue(item["disabled"]),
			Unavailable: boolValue(item["unavailable"]), Success: int64Value(item["success"]),
			Failed: int64Value(item["failed"]), Source: "oauth", Models: []string{},
			CanInspect: true, CanToggle: true, CanDelete: true,
		}
		if account.ID == "" {
			account.ID = firstProviderValue(account.AuthIndex, account.Name)
		}
		result = append(result, account)
	}
	return result, nil
}

func providerConfigAccounts(payload []byte) ([]providerAccount, error) {
	var config map[string]json.RawMessage
	if err := json.Unmarshal(payload, &config); err != nil {
		return nil, err
	}
	if nested := config["config"]; len(nested) > 0 {
		var nestedConfig map[string]json.RawMessage
		if json.Unmarshal(nested, &nestedConfig) == nil {
			config = nestedConfig
		}
	}
	result := make([]providerAccount, 0)
	for _, definition := range providerConfigDefinitions {
		var items []map[string]any
		if len(config[definition.path]) == 0 || json.Unmarshal(config[definition.path], &items) != nil {
			continue
		}
		for index, item := range items {
			result = append(result, providerConfigAccount(definition.path, definition.provider, definition.kind, index, item))
		}
	}
	return result, nil
}

func providerConfigAccount(path, provider, kind string, index int, item map[string]any) providerAccount {
	name := strings.TrimSpace(stringValue(item["name"]))
	prefix := strings.TrimSpace(stringValue(item["prefix"]))
	if name == "" {
		name = prefix
	}
	if name == "" {
		name = fmt.Sprintf("%s #%d", provider, index+1)
	}
	models := providerModelNames(item["models"])
	keyCount := 1
	if entries, ok := item["api-key-entries"].([]any); ok {
		keyCount = len(entries)
	}
	configIndex := index
	return providerAccount{
		ID: "config:" + path + ":" + strconv.Itoa(index), AuthIndex: strings.TrimSpace(stringValue(item["auth-index"])),
		Name: "config:" + path + ":" + strconv.Itoa(index), Label: name, Provider: provider, Type: kind,
		Status: "已配置", Disabled: boolValue(item["disabled"]), Source: "config",
		ConfigPath: path, ConfigIndex: &configIndex, BaseURL: strings.TrimSpace(stringValue(item["base-url"])),
		Prefix: prefix, Models: models, KeyCount: keyCount,
		CanInspect: true, CanToggle: path == "openai-compatibility", CanDelete: true,
	}
}

func providerModelNames(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		var model string
		switch typed := item.(type) {
		case string:
			model = typed
		case map[string]any:
			model = firstProviderValue(stringValue(typed["alias"]), stringValue(typed["name"]))
		}
		model = strings.TrimSpace(model)
		key := strings.ToLower(model)
		if model == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, model)
	}
	return result
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func firstProviderValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func int64Value(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		result, _ := typed.Int64()
		return result
	default:
		result, _ := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
		return result
	}
}

func parseConfigAccountName(name string) (string, int, bool) {
	parts := strings.Split(name, ":")
	if len(parts) != 3 || parts[0] != "config" {
		return "", 0, false
	}
	index, err := strconv.Atoi(parts[2])
	if err != nil || index < 0 {
		return "", 0, false
	}
	for _, definition := range providerConfigDefinitions {
		if parts[1] == definition.path {
			return parts[1], index, true
		}
	}
	return "", 0, false
}

func (a *App) loadProviderConfigItems(r *http.Request, path string) ([]json.RawMessage, error) {
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("CPA returned HTTP %d", status)
	}
	var direct []json.RawMessage
	if json.Unmarshal(payload, &direct) == nil {
		return direct, nil
	}
	var wrapped map[string]json.RawMessage
	if err := json.Unmarshal(payload, &wrapped); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(wrapped[path], &direct); err != nil {
		return nil, err
	}
	return direct, nil
}

func (a *App) saveProviderConfigItems(r *http.Request, path string, items []json.RawMessage) (int, []byte, error) {
	return a.cpa.Management(r.Context(), http.MethodPut, path, items)
}
