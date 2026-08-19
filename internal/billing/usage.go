package billing

import (
	"bufio"
	"bytes"
	"encoding/json"
	"math"
	"strings"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

type Result struct {
	RequestID           string
	ResponseServiceTier string
	Usage               store.Usage
	Found               bool
}

func ParseResponse(payload []byte) Result {
	var result Result
	consume := func(data []byte) {
		var value map[string]any
		if json.Unmarshal(data, &value) != nil {
			return
		}
		if id := stringValue(value["id"]); id != "" {
			result.RequestID = id
		}
		if response, ok := value["response"].(map[string]any); ok {
			if id := stringValue(response["id"]); id != "" {
				result.RequestID = id
			}
			readUsage(response["usage"], &result)
			if tier := stringValue(response["service_tier"]); tier != "" {
				result.ResponseServiceTier = tier
			}
		}
		if tier := stringValue(value["service_tier"]); tier != "" {
			result.ResponseServiceTier = tier
		}
		readUsage(value["usage"], &result)
		// Kimi may emit message-shaped streaming events even when Relay exposes
		// the request through the OpenAI-compatible surface.
		if message, ok := value["message"].(map[string]any); ok {
			if id := stringValue(message["id"]); id != "" {
				result.RequestID = id
			}
			readUsage(message["usage"], &result)
		}
		if event, ok := value["data"].(map[string]any); ok {
			if id := stringValue(event["id"]); id != "" {
				result.RequestID = id
			}
			readUsage(event["usage"], &result)
		}
	}
	consume(payload)
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if bytes.HasPrefix(line, []byte("data:")) {
			data := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
			if !bytes.Equal(data, []byte("[DONE]")) {
				consume(data)
			}
		}
	}
	// Cache writes are represented separately from Prompt throughout billing.
	// Recompute this lower bound after all streaming events have been consumed so
	// a later output-only delta cannot leave Total at the message_start value.
	result.Usage.Total = maxInt(result.Usage.Total, saturatingSum(
		result.Usage.Prompt, result.Usage.CacheWrite, result.Usage.Completion,
	))
	return result
}

func readUsage(raw any, result *Result) {
	usage, ok := raw.(map[string]any)
	if !ok {
		return
	}
	result.Found = true
	inputTokens := maxInt(
		number(usage["input_tokens"]), number(usage["prompt_tokens"]),
	)
	cacheReadTokens := maxInt(
		number(usage["cached_tokens"]), number(usage["cache_read_input_tokens"]),
		nestedNumber(usage, "input_tokens_details", "cached_tokens"),
		nestedNumber(usage, "prompt_tokens_details", "cached_tokens"),
	)
	cacheWriteTokens := maxInt(
		number(usage["cache_creation_input_tokens"]), number(usage["cache_write_tokens"]),
		nestedNumber(usage, "input_tokens_details", "cache_write_tokens"),
		nestedNumber(usage, "prompt_tokens_details", "cache_write_tokens"),
	)
	// Kimi and similar providers report uncached input, cache reads, and cache
	// writes as disjoint counters. Internally Prompt includes cache reads
	// (CostNanoUSD subtracts Cached from Prompt) while cache writes remain a
	// separate counter. OpenAI-style input_tokens already includes cached
	// tokens, so only normalize when these explicit cache fields are present.
	if hasAnyKey(usage, "cache_read_input_tokens", "cache_creation_input_tokens") {
		inputTokens = saturatingSum(inputTokens, cacheReadTokens)
	}
	result.Usage.Prompt = maxInt(result.Usage.Prompt, inputTokens)
	result.Usage.Completion = maxInt(result.Usage.Completion,
		number(usage["output_tokens"]), number(usage["completion_tokens"]),
	)
	result.Usage.Total = maxInt(result.Usage.Total, number(usage["total_tokens"]))
	result.Usage.Cached = maxInt(result.Usage.Cached, cacheReadTokens)
	result.Usage.CacheWrite = maxInt(result.Usage.CacheWrite, cacheWriteTokens)
	result.Usage.Reasoning = maxInt(result.Usage.Reasoning,
		number(usage["reasoning_tokens"]), nestedNumber(usage, "output_tokens_details", "reasoning_tokens"),
	)
	result.Usage.ImageInput = maxInt(result.Usage.ImageInput,
		number(usage["input_image_tokens"]), nestedNumber(usage, "input_tokens_details", "image_tokens"),
	)
	result.Usage.CachedImageInput = maxInt(result.Usage.CachedImageInput,
		number(usage["cached_image_tokens"]), nestedNumber(usage, "input_tokens_details", "cached_image_tokens"),
		nestedNestedNumber(usage, "input_tokens_details", "cached_tokens_details", "image_tokens"),
	)
	imageOutput := maxInt(number(usage["output_image_tokens"]), nestedNumber(usage, "output_tokens_details", "image_tokens"))
	if imageOutput == 0 && imageGenerationUsage(usage) {
		imageOutput = number(usage["output_tokens"])
	}
	result.Usage.ImageOutput = maxInt(result.Usage.ImageOutput, imageOutput)
}

func imageGenerationUsage(usage map[string]any) bool {
	details, ok := usage["input_tokens_details"].(map[string]any)
	if !ok {
		return false
	}
	_, hasImages := details["image_tokens"]
	_, hasText := details["text_tokens"]
	return hasImages || hasText
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
func number(value any) int64 {
	switch v := value.(type) {
	case float64:
		if v > 0 {
			return int64(v)
		}
	case json.Number:
		n, _ := v.Int64()
		if n > 0 {
			return n
		}
	}
	return 0
}
func nestedNumber(value map[string]any, key, child string) int64 {
	nested, _ := value[key].(map[string]any)
	return number(nested[child])
}
func nestedNestedNumber(value map[string]any, key, child, grandchild string) int64 {
	nested, _ := value[key].(map[string]any)
	return nestedNumber(nested, child, grandchild)
}
func hasAnyKey(value map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := value[key]; ok {
			return true
		}
	}
	return false
}
func saturatingSum(values ...int64) int64 {
	result := int64(0)
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if result > math.MaxInt64-value {
			return math.MaxInt64
		}
		result += value
	}
	return result
}
func maxInt(values ...int64) int64 {
	var result int64
	for _, value := range values {
		if value > result {
			result = value
		}
	}
	return result
}

func Cost(price pricing.SnapshotPrice, usage store.Usage) int64 {
	return pricing.CostNanoUSD(price, pricing.Usage{
		Prompt: usage.Prompt, Completion: usage.Completion, Cached: usage.Cached,
		CacheWrite: usage.CacheWrite, Reasoning: usage.Reasoning, Total: usage.Total,
		ImageInput: usage.ImageInput, CachedImageInput: usage.CachedImageInput, ImageOutput: usage.ImageOutput,
	})
}

// UsageComplete prevents a successful image response with stripped modality
// details from being settled as a text-only (and therefore nearly free) call.
func UsageComplete(price pricing.SnapshotPrice, usage store.Usage) bool {
	return price.ImageOutputNanoUSDPerToken == 0 || usage.ImageOutput > 0
}
