package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

const maxModelCatalogBytes int64 = 256 << 20

func isNativeModelCatalogRequest(r *http.Request) bool {
	if r == nil || r.Method != http.MethodGet {
		return false
	}
	path := strings.TrimRight(r.URL.Path, "/")
	return path == "/v1/models" || path == "/v1beta/models"
}

// proxyNativeModels preserves CPA's client-specific OpenAI, Anthropic, Codex,
// Grok and Gemini catalog formats, then applies Relay's tenant allowlist.
func (a *App) proxyNativeModels(w http.ResponseWriter, r *http.Request, key store.KeyContext) {
	targetCPA := a.inferenceCPA()
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetCPA.URL(r.URL.RequestURI()), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "model_catalog_error", err.Error())
		return
	}
	copyHeaders(request.Header, r.Header)
	request.Header.Set("Authorization", "Bearer "+targetCPA.APIKey)
	request.Header.Del("X-API-Key")
	request.Header.Del("X-Goog-API-Key")
	request.Host = targetCPA.BaseURL.Host
	response, err := targetCPA.ControlHTTP.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "model_catalog_error", "无法读取模型列表")
		return
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxModelCatalogBytes))
	if err != nil {
		writeError(w, http.StatusBadGateway, "model_catalog_error", "无法读取模型列表")
		return
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		models := []string(nil)
		if a.nativeCPARuntime != nil {
			models = a.nativeCPARuntime.Models()
		}
		allowedModels := make([]string, 0, len(models))
		for _, model := range models {
			if allowed(model, key.ModelAllowlist, key.TenantModels) {
				allowedModels = append(allowedModels, model)
			}
		}
		if filtered, filterErr := filterModelCatalog(payload, allowedModels); filterErr == nil {
			payload = filtered
		} else {
			writeError(w, http.StatusBadGateway, "model_catalog_error", fmt.Sprintf("模型列表格式无效: %v", filterErr))
			return
		}
	}
	copyHeaders(w.Header(), response.Header)
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, bytes.NewReader(payload))
}

func filterModelCatalog(payload []byte, allowedModels []string) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	allowedSet := make(map[string]struct{}, len(allowedModels)*3)
	for _, model := range allowedModels {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		allowedSet[strings.ToLower(model)] = struct{}{}
		allowedSet[strings.ToLower("models/"+model)] = struct{}{}
		if !strings.HasPrefix(strings.ToLower(model), "claude-") {
			allowedSet[strings.ToLower("claude-fable-5-dd-"+reverseString(model))] = struct{}{}
		}
	}
	for _, key := range []string{"data", "models"} {
		items, ok := document[key].([]any)
		if !ok {
			continue
		}
		filtered := make([]any, 0, len(items))
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id := catalogModelID(item)
			if _, exists := allowedSet[strings.ToLower(id)]; exists {
				filtered = append(filtered, raw)
			}
		}
		document[key] = filtered
		if key == "data" {
			_, hasMore := document["has_more"]
			_, hasFirst := document["first_id"]
			_, hasLast := document["last_id"]
			if hasMore || hasFirst || hasLast {
				document["has_more"] = false
				document["first_id"] = ""
				document["last_id"] = ""
				if len(filtered) > 0 {
					first, _ := filtered[0].(map[string]any)
					last, _ := filtered[len(filtered)-1].(map[string]any)
					document["first_id"] = catalogModelID(first)
					document["last_id"] = catalogModelID(last)
				}
			}
		}
	}
	return json.Marshal(document)
}

func catalogModelID(item map[string]any) string {
	for _, key := range []string{"id", "model", "name"} {
		if value, ok := item[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func reverseString(value string) string {
	runes := []rune(value)
	for left, right := 0, len(runes)-1; left < right; left, right = left+1, right-1 {
		runes[left], runes[right] = runes[right], runes[left]
	}
	return string(runes)
}
