package app

import (
	"encoding/json"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

// Public IDs describe the model author, never the credential/transport vendor.
// Qualified and unknown IDs are preserved; suffixes and spelling are not guessed.
func (a *App) canonicalModelID(model string) string {
	if strings.Contains(model, "/") {
		return model
	}
	owner := ""
	lower := strings.ToLower(model)
	switch {
	case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "codex-"),
		lower == "o1", lower == "o3", lower == "o4", strings.HasPrefix(lower, "o1-"), strings.HasPrefix(lower, "o3-"), strings.HasPrefix(lower, "o4-"):
		owner = "openai"
	case strings.HasPrefix(lower, "grok-"):
		owner = "x-ai"
	case strings.HasPrefix(lower, "claude-"):
		owner = "anthropic"
	case strings.HasPrefix(lower, "gemini-"):
		owner = "google"
	case strings.HasPrefix(lower, "kimi-"):
		owner = "moonshotai"
	case strings.HasPrefix(lower, "deepseek-"):
		owner = "deepseek"
	default:
		// Only an exact model fact supplies an otherwise unknown author. Lookup
		// also supports dated fallbacks, which must not rename a dated model.
		if fact, ok := a.capabilityIndex().LookupCatalog(model); ok {
			author, slug, qualified := strings.Cut(fact.ID, "/")
			if qualified && slug == model && strings.EqualFold(author, fact.Provider) {
				// models.dev also lists aggregators and hosting platforms.
				// Only known authors can supply an inferred namespace.
				switch strings.ToLower(author) {
				case "openai", "anthropic", "google", "deepseek", "moonshotai", "cohere", "nvidia", "minimax", "meta":
					owner = strings.ToLower(author)
				case "xai":
					owner = "x-ai"
				case "alibaba", "qwen":
					owner = "qwen"
				case "mistral", "mistralai":
					owner = "mistralai"
				case "zai", "zhipuai":
					owner = "z-ai"
				}
			}
		}
	}
	if owner == "" {
		return model
	}
	return owner + "/" + model
}

// Generated aliases cannot shadow an existing runtime ID or a user alias.
// They resolve to the original ID before authorization, admission and billing.
func (a *App) modelIDAliases(key store.KeyContext) []store.APIKeyModelAlias {
	if a == nil || a.nativeRuntime == nil {
		return nil
	}
	models := a.nativeRuntime.Models()
	occupied := make(map[string]bool, len(models)+len(key.ModelAliases))
	explicit := make(map[string]bool, len(key.ModelAliases))
	for _, model := range models {
		occupied[strings.ToLower(model)] = true
	}
	for _, alias := range key.ModelAliases {
		occupied[strings.ToLower(alias.Alias)] = true
		explicit[strings.ToLower(alias.Alias)] = true
	}
	aliases := make([]store.APIKeyModelAlias, 0, len(models))
	for _, model := range models {
		id := a.canonicalModelID(model)
		if id == model || occupied[strings.ToLower(id)] {
			continue
		}
		// An explicit alias shadowing the old ID retains its existing meaning.
		if explicit[strings.ToLower(model)] {
			continue
		}
		occupied[strings.ToLower(id)] = true
		aliases = append(aliases, store.APIKeyModelAlias{Alias: id, Model: model})
	}
	return aliases
}

func (a *App) modelIDKey(key store.KeyContext) store.KeyContext {
	generated := a.modelIDAliases(key)
	aliases := append([]store.APIKeyModelAlias(nil), key.ModelAliases...)
	for i := range aliases {
		aliases[i].Model = resolveAPIKeyModel(aliases[i].Model, generated).Model
	}
	key.ModelAliases = append(aliases, generated...)
	return key
}

func (a *App) resolveClientModel(model string, key store.KeyContext) requestMeta {
	key = a.modelIDKey(key)
	return resolveAPIKeyModel(model, key.ModelAliases)
}

// The standard list prefers canonical IDs. Single-model legacy lookups keep
// their requested ID; Codex keeps complete hidden legacy rows for cache merges.
func projectCanonicalModelIDs(payload []byte, generated []store.APIKeyModelAlias, codex, single bool) ([]byte, error) {
	if len(generated) == 0 {
		return payload, nil
	}
	byLegacy, byCanonical := map[string]store.APIKeyModelAlias{}, map[string]store.APIKeyModelAlias{}
	for _, alias := range generated {
		byLegacy[strings.ToLower(alias.Model)] = alias
		byCanonical[strings.ToLower(alias.Alias)] = alias
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	for _, field := range []string{"data", "models"} {
		items, ok := document[field].([]any)
		if !ok {
			continue
		}
		present := make(map[string]map[string]any, len(items))
		for _, raw := range items {
			if item, ok := raw.(map[string]any); ok {
				present[strings.ToLower(strings.TrimPrefix(catalogModelID(item), "models/"))] = item
			}
		}
		out := make([]any, 0, len(items))
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id := strings.TrimPrefix(catalogModelID(item), "models/")
			legacy := false
			if alias, ok := byCanonical[strings.ToLower(id)]; ok {
				item["canonical_slug"] = alias.Alias
				item["legacy_ids"] = []string{alias.Model}
				if original := present[strings.ToLower(alias.Model)]; original != nil {
					for _, field := range []string{"display_name", "displayName", "description"} {
						if value, exists := original[field]; exists {
							item[field] = value
						}
					}
				}
				if _, exists := item["owned_by"]; exists {
					item["owned_by"], _, _ = strings.Cut(alias.Alias, "/")
				}
			} else if alias, ok := byLegacy[strings.ToLower(id)]; ok && present[strings.ToLower(alias.Alias)] != nil {
				item["canonical_slug"] = alias.Alias
				legacy = true
			}
			if legacy && !single {
				if !codex {
					continue
				}
				item["visibility"] = "hide"
			}
			out = append(out, item)
		}
		document[field] = out
		if field == "data" {
			if _, paginated := document["has_more"]; paginated {
				document["first_id"], document["last_id"] = "", ""
				if len(out) > 0 {
					document["first_id"] = catalogModelID(out[0].(map[string]any))
					document["last_id"] = catalogModelID(out[len(out)-1].(map[string]any))
				}
			}
		}
	}
	return json.Marshal(document)
}
