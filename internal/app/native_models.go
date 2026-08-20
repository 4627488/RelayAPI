package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

const maxModelCatalogBytes int64 = 256 << 20

// Bump this when the Codex ModelInfo shape changes so clients refresh
// GET /v1/models and honor X-Models-Etag on subsequent Responses calls.
const codexCatalogRevisionToken = "codex-modelinfo-v3"

func isNativeModelCatalogRequest(r *http.Request) bool {
	if r == nil || r.Method != http.MethodGet {
		return false
	}
	path := strings.TrimRight(r.URL.Path, "/")
	return path == "/v1/models"
}

// serveModelCatalog preserves the standard OpenAI and rich Codex catalog
// formats, then applies Relay's tenant and key policy.
func (a *App) serveModelCatalog(w http.ResponseWriter, r *http.Request, key store.KeyContext) {
	if a.nativeRuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "model_catalog_error", "模型运行时不可用")
		return
	}
	prepareRuntimeHeaders(r.Header, "", "")
	recorder := httptest.NewRecorder()
	a.nativeRuntime.ServeModels(recorder, r)
	response := recorder.Result()
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxModelCatalogBytes))
	if err != nil {
		writeError(w, http.StatusBadGateway, "model_catalog_error", "无法读取模型列表")
		return
	}
	runtimeModels := []string(nil)
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		runtimeModels = a.nativeRuntime.Models()
		allowedModels := make([]string, 0, len(runtimeModels))
		for _, model := range runtimeModels {
			if key.AllowsModel(model) {
				allowedModels = append(allowedModels, model)
			}
		}
		_, codexCatalog := r.URL.Query()["client_version"]
		if filtered, filterErr := filterModelCatalogForClient(payload, allowedModels, codexCatalog); filterErr == nil {
			payload = filtered
		} else {
			writeError(w, http.StatusBadGateway, "model_catalog_error", fmt.Sprintf("模型列表格式无效: %v", filterErr))
			return
		}
		if codexCatalog {
			promoted, promoteErr := promoteCodexCatalogCapabilities(payload, a.capabilityIndex())
			if promoteErr != nil {
				writeError(w, http.StatusBadGateway, "model_catalog_error", fmt.Sprintf("Codex 模型能力无效: %v", promoteErr))
				return
			}
			payload = promoted
			if expanded, expandErr := addCodexModelAliases(payload, key.ModelAliases); expandErr == nil {
				payload = expanded
			} else {
				writeError(w, http.StatusBadGateway, "model_catalog_error", fmt.Sprintf("Codex 模型列表格式无效: %v", expandErr))
				return
			}
			if !a.upstreamWebSockets() {
				disabled, policyErr := applyCodexCatalogWebSocketPolicy(payload, false)
				if policyErr != nil {
					writeError(w, http.StatusBadGateway, "model_catalog_error", fmt.Sprintf("Codex 模型传输策略无效: %v", policyErr))
					return
				}
				payload = disabled
			}
		}
	}
	copyHeaders(w.Header(), response.Header)
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Type", "application/json")
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		etag := modelCatalogRevision(key, runtimeModels, a.codexCatalogRevisionToken())
		w.Header().Set("ETag", etag)
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, bytes.NewReader(payload))
}

// promoteCodexCatalogCapabilities implements Relay's default product policy:
// expose the richest Codex agent surface and let the provider adapter lower
// unsupported wire details. Every catalog row — including hide tombstones —
// must be a complete ModelInfo so Codex does not reject the remote list.
// Non-OpenAI slugs then take context, modalities, and reasoning levels from
// the latest models.dev snapshot when one is loaded.
func promoteCodexCatalogCapabilities(payload []byte, index *pricing.CapabilityIndex) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	items, ok := document["models"].([]any)
	if !ok {
		return nil, fmt.Errorf("missing models array")
	}
	for _, raw := range items {
		item, itemOK := raw.(map[string]any)
		if !itemOK {
			continue
		}
		upstream.CompleteCodexCatalogItem(item, 0)
		applyModelsDevCapability(item, catalogModelID(item), index)
	}
	visible, hidden := 0, 0
	for _, raw := range items {
		item, itemOK := raw.(map[string]any)
		if !itemOK {
			continue
		}
		if item["visibility"] == "hide" {
			hidden++
			item["priority"] = 10000 + hidden*10
			continue
		}
		visible++
		item["priority"] = 100 + visible*10
	}
	return json.Marshal(document)
}

func applyCodexCatalogWebSocketPolicy(payload []byte, enabled bool) ([]byte, error) {
	if enabled {
		return payload, nil
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	items, ok := document["models"].([]any)
	if !ok {
		return nil, fmt.Errorf("missing models array")
	}
	for _, raw := range items {
		item, itemOK := raw.(map[string]any)
		if !itemOK {
			continue
		}
		item["prefer_websockets"] = false
	}
	return json.Marshal(document)
}

func applyModelsDevCapability(item map[string]any, slug string, index *pricing.CapabilityIndex) {
	if item == nil || index == nil {
		return
	}
	capability, ok := index.Lookup(slug)
	if !ok {
		return
	}
	if capability.Source != pricing.SourceAdmin && skipModelsDevOverlay(slug, capability) {
		return
	}
	if capability.Name != "" {
		item["display_name"] = capability.Name
	}
	if capability.Context > 0 {
		item["context_window"] = capability.Context
		item["max_context_window"] = capability.Context
	}
	if capability.MaxOutput > 0 {
		item["max_output_tokens"] = capability.MaxOutput
	}
	if modalities := codexInputModalities(capability.InputModalities); len(modalities) > 0 {
		item["input_modalities"] = modalities
		supportsImage := false
		for _, modality := range modalities {
			if modality == "image" {
				supportsImage = true
			}
		}
		item["supports_image_detail_original"] = supportsImage
		if supportsImage {
			item["web_search_tool_type"] = "text_and_image"
		} else {
			item["web_search_tool_type"] = "text"
		}
	}
	if levels, defaultLevel := modelsDevReasoningLevels(capability); len(levels) > 0 {
		item["supported_reasoning_levels"] = levels
		item["default_reasoning_level"] = defaultLevel
	}
	if capability.PreferWebSockets != nil {
		item["prefer_websockets"] = *capability.PreferWebSockets
		if !*capability.PreferWebSockets {
			item["support_verbosity"] = false
			delete(item, "multi_agent_version")
		}
	} else {
		switch strings.ToLower(capability.Provider) {
		case "moonshotai", "moonshotai-cn", "deepseek":
			item["prefer_websockets"] = false
			item["support_verbosity"] = false
			delete(item, "multi_agent_version")
		}
	}
}

func skipModelsDevOverlay(slug string, capability pricing.Capability) bool {
	if strings.EqualFold(capability.Provider, "openai") {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(slug))
	switch {
	case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "o1-"),
		strings.HasPrefix(lower, "o3-"), strings.HasPrefix(lower, "o4-"),
		strings.HasPrefix(lower, "codex-"):
		return true
	default:
		return false
	}
}

func modelsDevReasoningLevels(capability pricing.Capability) ([]any, string) {
	var effort []string
	toggle := false
	for _, option := range capability.ReasoningOptions {
		switch option.Type {
		case "toggle":
			toggle = true
		case "effort":
			effort = append(effort, option.Values...)
		}
	}
	if len(effort) > 0 {
		defaultLevel := pickDefaultReasoningLevel(effort, false)
		if wanted := strings.ToLower(strings.TrimSpace(capability.DefaultLevel)); wanted != "" {
			for _, value := range effort {
				if strings.EqualFold(value, wanted) {
					defaultLevel = wanted
					break
				}
			}
		}
		return reasoningLevelObjects(effort), defaultLevel
	}
	if toggle {
		return reasoningLevelObjects([]string{"none", "high"}), "high"
	}
	if capability.Reasoning {
		return reasoningLevelObjects([]string{"high"}), "high"
	}
	return reasoningLevelObjects([]string{"none"}), "none"
}

func reasoningLevelObjects(efforts []string) []any {
	levels := make([]any, 0, len(efforts))
	seen := make(map[string]struct{}, len(efforts))
	for _, effort := range efforts {
		effort = strings.ToLower(strings.TrimSpace(effort))
		if effort == "" {
			continue
		}
		if _, exists := seen[effort]; exists {
			continue
		}
		seen[effort] = struct{}{}
		levels = append(levels, map[string]any{"effort": effort, "description": reasoningLevelDescription(effort)})
	}
	return levels
}

func pickDefaultReasoningLevel(efforts []string, allowNone bool) string {
	preferred := []string{"medium", "high", "low", "max", "xhigh"}
	if allowNone {
		preferred = append(preferred, "none")
	}
	have := make(map[string]struct{}, len(efforts))
	first := ""
	for _, effort := range efforts {
		effort = strings.ToLower(strings.TrimSpace(effort))
		if effort == "" {
			continue
		}
		if first == "" {
			first = effort
		}
		have[effort] = struct{}{}
	}
	for _, effort := range preferred {
		if _, ok := have[effort]; ok {
			return effort
		}
	}
	if first != "" {
		return first
	}
	return "medium"
}

func reasoningLevelDescription(level string) string {
	switch level {
	case "none":
		return "Fastest responses with limited reasoning"
	case "minimal":
		return "Fastest responses with minimal reasoning"
	case "low":
		return "Fast responses with lighter reasoning"
	case "medium":
		return "Balances speed and reasoning depth for everyday tasks"
	case "high":
		return "Greater reasoning depth for complex problems"
	case "xhigh":
		return "Extra high reasoning depth for complex problems"
	case "max":
		return "Maximum available reasoning depth for complex problems"
	default:
		return level
	}
}

func codexInputModalities(values []string) []any {
	result := make([]any, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "text" && value != "image" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func filterModelCatalog(payload []byte, allowedModels []string) ([]byte, error) {
	return filterModelCatalogForClient(payload, allowedModels, false)
}

// filterModelCatalogForClient treats Codex catalogs differently from the
// standard OpenAI catalog. Codex merges a custom provider's catalog with its
// bundled models by slug. Removing a denied model is therefore insufficient:
// the bundled copy can reappear in the picker. Keeping the entry as a hidden
// override makes the remote policy authoritative while inference permission
// checks remain the security boundary.
func filterModelCatalogForClient(payload []byte, allowedModels []string, codex bool) ([]byte, error) {
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
			} else if codex && key == "models" {
				hidden := cloneCatalogItem(item)
				hidden["visibility"] = "hide"
				filtered = append(filtered, hidden)
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

func cloneCatalogItem(item map[string]any) map[string]any {
	cloned := make(map[string]any, len(item))
	for key, value := range item {
		cloned[key] = value
	}
	return cloned
}

func modelCatalogETag(payload []byte) string {
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("\"relay-models-%x\"", sum[:16])
}

func etagMatches(header, current string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == current {
			return true
		}
	}
	return false
}

// modelCatalogRevision identifies the effective catalog visible to one API
// key without embedding secrets. It is used on Responses calls so Codex can
// refresh its picker immediately after a permission, alias, or upstream
// catalog change.
func modelCatalogRevision(key store.KeyContext, models []string, upstreamETag string) string {
	type alias struct {
		Name  string `json:"name"`
		Model string `json:"model"`
	}
	visible := make([]string, 0, len(models))
	for _, model := range models {
		if key.AllowsModel(model) {
			visible = append(visible, strings.ToLower(strings.TrimSpace(model)))
		}
	}
	sort.Strings(visible)
	aliases := make([]alias, 0, len(key.ModelAliases))
	for _, item := range key.ModelAliases {
		aliases = append(aliases, alias{Name: strings.ToLower(strings.TrimSpace(item.Alias)), Model: strings.ToLower(strings.TrimSpace(item.Model))})
	}
	sort.Slice(aliases, func(left, right int) bool {
		if aliases[left].Name == aliases[right].Name {
			return aliases[left].Model < aliases[right].Model
		}
		return aliases[left].Name < aliases[right].Name
	})
	payload, _ := json.Marshal(struct {
		Models       []string `json:"models"`
		Aliases      []alias  `json:"aliases"`
		UpstreamETag string   `json:"upstream_etag"`
	}{Models: visible, Aliases: aliases, UpstreamETag: strings.TrimSpace(upstreamETag)})
	return modelCatalogETag(payload)
}

func catalogModelID(item map[string]any) string {
	for _, key := range []string{"id", "model", "name", "slug"} {
		if value, ok := item[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// addCodexModelAliases exposes API-key aliases in Codex's private model
// catalog. Each alias inherits the target model's capabilities while keeping
// the alias as the client-visible slug used in subsequent requests.
func addCodexModelAliases(payload []byte, aliases []store.APIKeyModelAlias) ([]byte, error) {
	if len(aliases) == 0 {
		return payload, nil
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	items, ok := document["models"].([]any)
	if !ok {
		return nil, fmt.Errorf("missing models array")
	}
	targets := make(map[string]map[string]any, len(items))
	positions := make(map[string]int, len(items)+len(aliases))
	for index, raw := range items {
		item, itemOK := raw.(map[string]any)
		if !itemOK {
			continue
		}
		id := strings.ToLower(catalogModelID(item))
		if id == "" {
			continue
		}
		targets[id] = item
		positions[id] = index
	}
	for _, mapping := range aliases {
		alias := strings.TrimSpace(mapping.Alias)
		targetID := strings.TrimSpace(mapping.Model)
		if alias == "" || targetID == "" {
			continue
		}
		target := targets[strings.ToLower(targetID)]
		if target == nil {
			continue
		}
		cloned := cloneCatalogItem(target)
		cloned["slug"] = alias
		cloned["display_name"] = alias
		cloned["description"] = fmt.Sprintf("RelayAPI 模型别名，映射到 %s", targetID)
		aliasKey := strings.ToLower(alias)
		if index, exists := positions[aliasKey]; exists {
			items[index] = cloned
		} else {
			positions[aliasKey] = len(items)
			items = append(items, cloned)
		}
	}
	document["models"] = items
	return json.Marshal(document)
}
