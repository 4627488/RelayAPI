package pricing

import "math"

type Usage struct {
	Prompt, Completion, Cached, CacheWrite, Reasoning, Total int64
}

// CostNanoUSD calculates a non-negative, saturating request cost. Some APIs
// include reasoning tokens inside output tokens (OpenAI), while others report
// them separately (Gemini). Total disambiguates those two shapes.
func CostNanoUSD(price SnapshotPrice, usage Usage) int64 {
	uncached := max64(0, usage.Prompt-usage.Cached)
	completion := max64(0, usage.Completion)
	reasoning := max64(0, usage.Reasoning)
	if reasoning > 0 && reasoningIncludedInCompletion(usage) {
		completion = max64(0, completion-reasoning)
	}

	result := int64(0)
	for _, item := range [][2]int64{
		{uncached, price.InputNanoUSDPerToken},
		{max64(0, usage.Cached), price.CachedInputNanoUSDPerToken},
		{completion, price.OutputNanoUSDPerToken},
		{max64(0, usage.CacheWrite), price.CacheWriteNanoUSDPerToken},
		{reasoning, price.ReasoningNanoUSDPerToken},
	} {
		result = saturatingAdd(result, saturatingMultiply(item[0], item[1]))
	}
	return result
}

func reasoningIncludedInCompletion(usage Usage) bool {
	if usage.Total <= usage.Prompt {
		return true
	}
	return usage.Total-usage.Prompt <= usage.Completion
}

func saturatingMultiply(left, right int64) int64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

func saturatingAdd(left, right int64) int64 {
	if left >= math.MaxInt64-right {
		return math.MaxInt64
	}
	return left + right
}

func max64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
