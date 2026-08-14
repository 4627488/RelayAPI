package app

import (
	"encoding/json"
	"fmt"
	"strings"
)

// normalizeSupportedProvider is the product boundary, not merely a UI list.
// Keeping it centralized prevents imported credential JSON from re-enabling a
// CPA executor that Relay intentionally does not expose.
func normalizeSupportedProvider(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "codex":
		return "codex", true
	case "kimi":
		return "kimi", true
	case "xai", "x.ai", "grok":
		return "xai", true
	case "openai":
		return "openai", true
	case "openai-compatible", "openai-compatibility":
		return "openai-compatibility", true
	case "aliyun-bailian", "bailian", "百炼":
		return "aliyun-bailian", true
	default:
		return "", false
	}
}

func validateSupportedCredentialDocument(provider string, document []byte) error {
	provider, ok := normalizeSupportedProvider(provider)
	if !ok {
		return fmt.Errorf("不支持的提供商")
	}
	var value map[string]any
	if err := json.Unmarshal(document, &value); err != nil {
		return fmt.Errorf("凭据 JSON 无效")
	}
	rawType, _ := value["type"].(string)
	if strings.TrimSpace(rawType) == "" {
		return nil
	}
	documentProvider, supported := normalizeSupportedProvider(rawType)
	if !supported {
		return fmt.Errorf("凭据类型 %q 不受支持", rawType)
	}
	if provider == "aliyun-bailian" {
		provider = "openai-compatibility"
	}
	if (provider == "openai" && documentProvider == "openai-compatibility") ||
		(provider == "openai-compatibility" && documentProvider == "openai") {
		return nil
	}
	if provider != documentProvider {
		return fmt.Errorf("凭据类型 %q 与提供商 %q 不匹配", rawType, provider)
	}
	return nil
}

func supportedStoredCredential(provider string, document []byte) bool {
	_, ok := normalizeSupportedProvider(provider)
	return ok && validateSupportedCredentialDocument(provider, document) == nil
}
