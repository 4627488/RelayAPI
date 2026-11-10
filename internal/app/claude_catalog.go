package app

import (
	"encoding/json"
	"sort"

	"github.com/4627488/RelayAPI/internal/rai"
)

// Add only documented Desktop discovery fields, after authorization and
// one-hop alias resolution. Other providers keep their original metadata.
func promoteClaudeCatalog(payload []byte, info map[string]rai.ModelInfo) ([]byte, error) {
	var doc map[string]any
	if err := json.Unmarshal(payload, &doc); err != nil {
		return nil, err
	}
	items, ok := doc["data"].([]any)
	if !ok {
		return payload, nil
	}
	var claude []map[string]any
	var positions []int
	familyDefault := map[string]string{}
	for i, raw := range items {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := catalogModelID(entry)
		fact, exists := info[id]
		family := rai.ClaudeModelFamily(id, fact)
		if !exists || family == "" {
			continue
		}
		canonical := rai.ClaudeModelID(id, fact)
		entry["anthropic_family_tier"] = family
		entry["is_family_default"] = false
		if fact.Name != "" {
			entry["display_name"] = fact.Name
		}
		if canonical != id {
			entry["behaves_as"] = canonical
		}
		window := fact.Context
		if fact.MaxInput > 0 && (window == 0 || fact.MaxInput < window) {
			window = fact.MaxInput
		}
		if window > 0 {
			entry["max_input_tokens"] = window
			entry["supports_1m"] = window >= 1000000
		}
		if fact.MaxOutput > 0 {
			entry["max_output_tokens"] = fact.MaxOutput
		}
		best := familyDefault[family]
		comparison := rai.CompareClaudeModels(canonical, rai.ClaudeModelID(best, info[best]))
		if best == "" || comparison > 0 || (comparison == 0 && id == canonical) {
			familyDefault[family] = id
		}
		positions = append(positions, i)
		claude = append(claude, entry)
	}
	rank := map[string]int{"sonnet": 0, "opus": 1, "haiku": 2, "fable": 3}
	for _, entry := range claude {
		family := entry["anthropic_family_tier"].(string)
		entry["is_family_default"] = familyDefault[family] == catalogModelID(entry)
	}
	// Desktop's initial default follows the first discovered Claude entry.
	// Keep non-Claude entries in place and maintain their relative ordering.
	sort.SliceStable(claude, func(i, j int) bool {
		a, b := claude[i], claude[j]
		af, bf := a["anthropic_family_tier"].(string), b["anthropic_family_tier"].(string)
		if rank[af] != rank[bf] {
			return rank[af] < rank[bf]
		}
		if a["is_family_default"] != b["is_family_default"] {
			return a["is_family_default"] == true
		}
		ai, bi := catalogModelID(a), catalogModelID(b)
		return rai.CompareClaudeModels(rai.ClaudeModelID(ai, info[ai]), rai.ClaudeModelID(bi, info[bi])) > 0
	})
	for i, entry := range claude {
		items[positions[i]] = entry
	}
	if len(claude) > 0 {
		if _, exists := doc["first_id"]; exists && len(items) > 0 {
			doc["first_id"] = catalogModelID(items[0].(map[string]any))
			doc["last_id"] = catalogModelID(items[len(items)-1].(map[string]any))
		}
	}
	return json.Marshal(doc)
}
