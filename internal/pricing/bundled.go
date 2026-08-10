package pricing

var BundledPrices = []Price{
	{Model: "gpt-5.2", InputNanoUSDPerToken: 1750, OutputNanoUSDPerToken: 14000, CachedInputNanoUSDPerToken: 175, CacheWriteNanoUSDPerToken: 1750, ReasoningNanoUSDPerToken: 14000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.3-codex", InputNanoUSDPerToken: 1750, OutputNanoUSDPerToken: 14000, CachedInputNanoUSDPerToken: 175, CacheWriteNanoUSDPerToken: 1750, ReasoningNanoUSDPerToken: 14000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.4", InputNanoUSDPerToken: 2500, OutputNanoUSDPerToken: 15000, CachedInputNanoUSDPerToken: 250, CacheWriteNanoUSDPerToken: 2500, ReasoningNanoUSDPerToken: 15000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.4-mini", InputNanoUSDPerToken: 750, OutputNanoUSDPerToken: 4500, CachedInputNanoUSDPerToken: 75, CacheWriteNanoUSDPerToken: 750, ReasoningNanoUSDPerToken: 4500, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.5", InputNanoUSDPerToken: 5000, OutputNanoUSDPerToken: 30000, CachedInputNanoUSDPerToken: 500, CacheWriteNanoUSDPerToken: 5000, ReasoningNanoUSDPerToken: 30000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.6", InputNanoUSDPerToken: 5000, OutputNanoUSDPerToken: 30000, CachedInputNanoUSDPerToken: 500, CacheWriteNanoUSDPerToken: 5000, ReasoningNanoUSDPerToken: 30000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.6-terra", InputNanoUSDPerToken: 2500, OutputNanoUSDPerToken: 15000, CachedInputNanoUSDPerToken: 250, CacheWriteNanoUSDPerToken: 2500, ReasoningNanoUSDPerToken: 15000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "gpt-5.6-sol", InputNanoUSDPerToken: 5000, OutputNanoUSDPerToken: 30000, CachedInputNanoUSDPerToken: 500, CacheWriteNanoUSDPerToken: 6250, ReasoningNanoUSDPerToken: 30000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	// OpenAI Standard pricing separates text input from image input/output.
	// The Images API reports the exact modality token counts, so production
	// billing uses those counts instead of an estimated flat per-image price.
	{Model: "gpt-image-2", InputNanoUSDPerToken: 5000, CachedInputNanoUSDPerToken: 1250, ImageInputNanoUSDPerToken: 8000, CachedImageInputNanoUSDPerToken: 2000, ImageOutputNanoUSDPerToken: 30000, Source: SourceBundled, Version: "openai-standard-2026-08-10", PriceMultiplier: 1},
	{Model: "xai/grok-4.5", InputNanoUSDPerToken: 2000, OutputNanoUSDPerToken: 6000, CachedInputNanoUSDPerToken: 500, CacheWriteNanoUSDPerToken: 2000, ReasoningNanoUSDPerToken: 6000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "xai/grok-4.3", InputNanoUSDPerToken: 1250, OutputNanoUSDPerToken: 2500, CachedInputNanoUSDPerToken: 200, CacheWriteNanoUSDPerToken: 1250, ReasoningNanoUSDPerToken: 2500, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "xai/grok-4.20-0309-reasoning", InputNanoUSDPerToken: 2000, OutputNanoUSDPerToken: 6000, CachedInputNanoUSDPerToken: 200, CacheWriteNanoUSDPerToken: 2000, ReasoningNanoUSDPerToken: 6000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "xai/grok-3-mini", InputNanoUSDPerToken: 300, OutputNanoUSDPerToken: 500, CachedInputNanoUSDPerToken: 75, CacheWriteNanoUSDPerToken: 300, ReasoningNanoUSDPerToken: 500, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
	{Model: "xai/grok-3-mini-fast", InputNanoUSDPerToken: 600, OutputNanoUSDPerToken: 4000, CachedInputNanoUSDPerToken: 150, CacheWriteNanoUSDPerToken: 600, ReasoningNanoUSDPerToken: 4000, Source: SourceBundled, Version: "bundled-2026-07-23", PriceMultiplier: 1},
}
