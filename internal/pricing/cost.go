package pricing

import "math"

type Usage struct {
	Prompt, Completion, Cached, CacheWrite, Reasoning, Total int64
	ImageInput, CachedImageInput, ImageOutput                int64
}

// CostNanoUSD calculates a non-negative, saturating request cost. Some APIs
// include reasoning tokens inside output tokens (OpenAI), while others report
// them separately (Gemini). Total disambiguates those two shapes.
func CostNanoUSD(price SnapshotPrice, usage Usage) int64 {
	imageInput := min64(max64(0, usage.ImageInput), max64(0, usage.Prompt))
	cachedInput := min64(max64(0, usage.Cached), max64(0, usage.Prompt))
	cachedImage := min64(max64(0, usage.CachedImageInput), min64(imageInput, cachedInput))
	textInput := max64(0, usage.Prompt-imageInput)
	cachedText := min64(textInput, max64(0, cachedInput-cachedImage))
	uncachedText := max64(0, textInput-cachedText)
	uncachedImage := max64(0, imageInput-cachedImage)

	imageOutput := min64(max64(0, usage.ImageOutput), max64(0, usage.Completion))
	completion := max64(0, usage.Completion-imageOutput)
	reasoning := max64(0, usage.Reasoning)
	if reasoning > 0 && reasoningIncludedInCompletion(usage) {
		completion = max64(0, completion-reasoning)
	}

	result := int64(0)
	for _, item := range [][2]int64{
		{uncachedText, price.InputNanoUSDPerToken},
		{cachedText, price.CachedInputNanoUSDPerToken},
		{uncachedImage, price.ImageInputNanoUSDPerToken},
		{cachedImage, price.CachedImageInputNanoUSDPerToken},
		{completion, price.OutputNanoUSDPerToken},
		{imageOutput, price.ImageOutputNanoUSDPerToken},
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

func min64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
