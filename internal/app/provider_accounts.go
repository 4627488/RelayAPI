package app

import (
	"encoding/json"
	"fmt"
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
	Models        []string `json:"models"`
	CanInspect    bool     `json:"can_inspect"`
	CanToggle     bool     `json:"can_toggle"`
	CanDelete     bool     `json:"can_delete"`
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
			ID: textValue(item["id"]), AuthIndex: textValue(item["auth_index"]),
			Name: textValue(item["name"]), Provider: textValue(item["provider"]),
			Type: textValue(item["type"]), Email: textValue(item["email"]),
			Label: textValue(item["label"]), Status: textValue(item["status"]),
			StatusMessage: textValue(item["status_message"]), Disabled: booleanValue(item["disabled"]),
			Unavailable: booleanValue(item["unavailable"]), Success: integerValue(item["success"]),
			Failed: integerValue(item["failed"]), Source: "oauth", Models: []string{},
			CanInspect: true, CanToggle: true, CanDelete: true,
		}
		if account.ID == "" {
			account.ID = firstText(account.AuthIndex, account.Name)
		}
		result = append(result, account)
	}
	return result, nil
}

func textValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func firstText(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func booleanValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func integerValue(value any) int64 {
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
