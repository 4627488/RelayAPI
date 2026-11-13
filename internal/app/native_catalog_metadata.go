package app

import (
	"encoding/json"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

// enrichResponsesCatalog uses Magpie's public list fields. Unknown capabilities
// and prices stay absent rather than inheriting guessed facts from an alias ID.
func enrichResponsesCatalog(payload []byte, index *pricing.CapabilityIndex, key store.KeyContext, priceFor func(string) (store.ResolvedPrice, error)) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	items, _ := document["data"].([]any)
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		clientModel := catalogModelID(item)
		model := resolveAPIKeyModel(clientModel, key.ModelAliases).Model
		facts := map[string]any{}
		applyModelsDevCapability(facts, model, index)
		item["supported_endpoints"] = []string{"/responses"}
		item["native_endpoints"] = []string{"/responses"}
		for _, field := range []string{"display_name", "max_output_tokens", "supported_reasoning_levels", "default_reasoning_level", "service_tiers"} {
			if value, exists := facts[field]; exists {
				item[field] = value
			}
		}
		if clientModel != model {
			item["display_name"] = clientModel
		}
		if context, exists := facts["context_window"]; exists {
			item["context_length"] = context
		}
		if input, exists := facts["input_modalities"]; exists {
			item["modalities"] = map[string]any{"input": input, "output": []string{"text"}}
		}
		if price, err := priceFor(model); err == nil {
			item["magpie_price"] = magpieModelPrice(price.Price)
		}
	}
	return json.Marshal(document)
}

// Magpie prices are USD per million tokens; Relay persists nanoUSD per token.
// Snapshot rates already include the operator's multiplier and matching rules.
func magpieModelPrice(price pricing.Price) map[string]any {
	row := func(input, output, read, write, hour int64) map[string]any {
		return map[string]any{
			"input": float64(input) / 1000, "output": float64(output) / 1000,
			"cache_read": float64(read) / 1000, "cache_write": float64(write) / 1000,
			"cache_write_1h": float64(hour) / 1000,
		}
	}
	result := row(price.InputNanoUSDPerToken, price.OutputNanoUSDPerToken, price.CachedInputNanoUSDPerToken, price.CacheWriteNanoUSDPerToken, price.CacheWrite1hNanoUSDPerToken)
	if len(price.Tiers) > 0 {
		tiers := make([]map[string]any, 0, len(price.Tiers))
		for _, tier := range price.Tiers {
			item := row(tier.InputNanoUSDPerToken, tier.OutputNanoUSDPerToken, tier.CachedInputNanoUSDPerToken, tier.CacheWriteNanoUSDPerToken, tier.CacheWrite1hNanoUSDPerToken)
			item["above"] = tier.Above
			tiers = append(tiers, item)
		}
		result["tiers"] = tiers
	}
	return result
}
