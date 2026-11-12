package billing

import (
	"bufio"
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

type Result struct {
	hasInput, hasOutput bool
	RequestID           string
	Model               string
	ResponseServiceTier string
	Usage               store.Usage
	Found               bool
	// UsageQuality preserves the runtime accounting classification. Empty is
	// reserved for legacy/native response parsing.
	UsageQuality string
}

func (r Result) NonGenerated() bool { return r.UsageQuality == "not_generated" }

func ParseResponse(payload []byte) Result {
	var result Result
	consume := func(data []byte) bool {
		var value map[string]any
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.UseNumber()
		if decoder.Decode(&value) != nil {
			return false
		}
		if id := stringValue(value["id"]); id != "" {
			result.RequestID = id
		}
		if model := stringValue(value["model"]); model != "" {
			result.Model = model
		}
		if response, ok := value["response"].(map[string]any); ok {
			if id := stringValue(response["id"]); id != "" {
				result.RequestID = id
			}
			if model := stringValue(response["model"]); model != "" {
				result.Model = model
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
		if g, ok := value["usageMetadata"].(map[string]any); ok {
			normalized := map[string]any{"cached_tokens": g["cachedContentTokenCount"], "reasoning_tokens": g["thoughtsTokenCount"]}
			if v, ok := g["promptTokenCount"]; ok {
				normalized["input_tokens"] = v
			}
			if hasAnyKey(g, "candidatesTokenCount", "thoughtsTokenCount") {
				normalized["output_tokens"] = json.Number(strconv.FormatInt(saturatingSum(number(g["candidatesTokenCount"]), number(g["thoughtsTokenCount"])), 10))
			}
			readUsage(normalized, &result)
		}
		// Kimi may emit message-shaped streaming events even when Relay exposes
		// the request through the OpenAI-compatible surface.
		if message, ok := value["message"].(map[string]any); ok {
			if id := stringValue(message["id"]); id != "" {
				result.RequestID = id
			}
			if model := stringValue(message["model"]); model != "" {
				result.Model = model
			}
			readUsage(message["usage"], &result)
		}
		if event, ok := value["data"].(map[string]any); ok {
			if id := stringValue(event["id"]); id != "" {
				result.RequestID = id
			}
			if model := stringValue(event["model"]); model != "" {
				result.Model = model
			}
			readUsage(event["usage"], &result)
		}
		return true
	}
	if !consume(payload) {
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
	}
	// Display tokens exclude cache traffic, as Magpie Totals.Tokens does.
	result.Usage.Total = result.Usage.Tokens()
	if result.Found && result.UsageQuality == "" {
		if result.hasInput && result.hasOutput {
			result.UsageQuality = "complete"
		} else {
			result.UsageQuality = "incomplete"
		}
	}
	if !result.Found {
		result.UsageQuality = "missing"
	}

	return result
}

func readUsage(raw any, result *Result) {
	usage, ok := raw.(map[string]any)
	if !ok || !hasAnyKey(usage, "input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "cache_read_input_tokens", "cache_creation_input_tokens") {
		return
	}
	result.Found = true
	result.hasInput = result.hasInput || hasAnyKey(usage, "input_tokens", "prompt_tokens")
	result.hasOutput = result.hasOutput || hasAnyKey(usage, "output_tokens", "completion_tokens")
	for _, key := range []string{"input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "cached_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_write_tokens", "reasoning_tokens"} {
		if v, exists := usage[key]; exists && (v != nil || key == "input_tokens" || key == "prompt_tokens" || key == "output_tokens" || key == "completion_tokens") {
			if n, ok := v.(json.Number); ok {
				if i, err := n.Int64(); err != nil || i < 0 {
					result.UsageQuality = "inconsistent"
				}
			} else {
				result.UsageQuality = "inconsistent"
			}
		}
	}
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
	// Anthropic-style input excludes both cache buckets. OpenAI input includes
	// cache traffic, so subtract it once at the protocol boundary.
	if !hasAnyKey(usage, "cache_read_input_tokens", "cache_creation_input_tokens") {
		if saturatingSum(cacheReadTokens, cacheWriteTokens) > inputTokens {
			result.UsageQuality = "inconsistent"
		}
		inputTokens = maxInt(0, inputTokens-cacheReadTokens-cacheWriteTokens)
	}
	result.Usage.CacheWrite1h = maxInt(result.Usage.CacheWrite1h, nestedNumber(usage, "cache_creation", "ephemeral_1h_input_tokens"))
	if unknown, ok := usage["magpie_cache_unknown"].(bool); ok {
		result.Usage.CacheUnknown = unknown
	}

	result.Usage.Input = maxInt(result.Usage.Input, inputTokens)
	result.Usage.Output = maxInt(result.Usage.Output,
		number(usage["output_tokens"]), number(usage["completion_tokens"]),
	)
	result.Usage.Total = maxInt(result.Usage.Total, number(usage["total_tokens"]))
	result.Usage.CacheRead = maxInt(result.Usage.CacheRead, cacheReadTokens)
	result.Usage.CacheWrite = maxInt(result.Usage.CacheWrite, cacheWriteTokens)
	result.Usage.Reasoning = maxInt(result.Usage.Reasoning,
		number(usage["reasoning_tokens"]), nestedNumber(usage, "output_tokens_details", "reasoning_tokens"), nestedNumber(usage, "completion_tokens_details", "reasoning_tokens"),
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
		n, err := v.Int64()
		if err != nil {
			f, _ := v.Float64()
			if f >= math.MaxInt64 {
				return math.MaxInt64
			}
			return 0
		}
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
	return pricing.CostNanoUSD(price, usage)
}

// UsageComplete prevents a successful image response with stripped modality
// details from being settled as a text-only (and therefore nearly free) call.
func UsageComplete(price pricing.SnapshotPrice, usage store.Usage) bool {
	return price.ImageOutputNanoUSDPerToken == 0 || usage.ImageOutput > 0
}

// Merge combines cumulative stream counters, never sums repeated usage frames.
// Each protocol event may carry only one side of a request's usage.
func Merge(dst *Result, src Result) {
	if src.RequestID != "" {
		dst.RequestID = src.RequestID
	}
	if src.Model != "" {
		dst.Model = src.Model
	}
	if src.ResponseServiceTier != "" {
		dst.ResponseServiceTier = src.ResponseServiceTier
	}
	if !src.Found {
		return
	}
	dst.Found = true
	invalid := dst.UsageQuality == "inconsistent" || src.UsageQuality == "inconsistent"
	dst.hasInput = dst.hasInput || src.hasInput
	dst.hasOutput = dst.hasOutput || src.hasOutput
	if invalid {
		dst.UsageQuality = "inconsistent"
	} else if dst.hasInput && dst.hasOutput {
		dst.UsageQuality = "complete"
	} else {
		dst.UsageQuality = src.UsageQuality
	}
	a, b := &dst.Usage, src.Usage
	a.Input = maxInt(a.Input, b.Input)
	a.Output = maxInt(a.Output, b.Output)
	a.CacheRead = maxInt(a.CacheRead, b.CacheRead)
	a.CacheWrite = maxInt(a.CacheWrite, b.CacheWrite)
	a.CacheWrite1h = maxInt(a.CacheWrite1h, b.CacheWrite1h)
	a.Reasoning = maxInt(a.Reasoning, b.Reasoning)
	a.ImageInput = maxInt(a.ImageInput, b.ImageInput)
	a.CachedImageInput = maxInt(a.CachedImageInput, b.CachedImageInput)
	a.ImageOutput = maxInt(a.ImageOutput, b.ImageOutput)
	a.CacheUnknown = a.CacheUnknown || b.CacheUnknown
	a.Total = a.Tokens()
}
