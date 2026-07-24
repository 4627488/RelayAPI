package billing

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

type Result struct {
	RequestID string
	Usage     store.Usage
	Found     bool
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
			readUsageMetadata(response["usageMetadata"], &result)
			readUsageMetadata(response["cpaUsageMetadata"], &result)
		}
		readUsage(value["usage"], &result)
		readUsageMetadata(value["usageMetadata"], &result)
		readUsageMetadata(value["cpaUsageMetadata"], &result)
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
	if result.Usage.Total == 0 {
		result.Usage.Total = result.Usage.Prompt + result.Usage.Completion
	}
	return result
}

func readUsageMetadata(raw any, result *Result) {
	usage, ok := raw.(map[string]any)
	if !ok {
		return
	}
	result.Found = true
	result.Usage.Prompt = maxInt(result.Usage.Prompt, number(usage["promptTokenCount"]))
	result.Usage.Completion = maxInt(result.Usage.Completion, number(usage["candidatesTokenCount"]))
	result.Usage.Total = maxInt(result.Usage.Total, number(usage["totalTokenCount"]))
	result.Usage.Cached = maxInt(result.Usage.Cached, number(usage["cachedContentTokenCount"]))
	result.Usage.Reasoning = maxInt(result.Usage.Reasoning, number(usage["thoughtsTokenCount"]))
}

func readUsage(raw any, result *Result) {
	usage, ok := raw.(map[string]any)
	if !ok {
		return
	}
	result.Found = true
	result.Usage.Prompt = maxInt(result.Usage.Prompt,
		number(usage["input_tokens"]), number(usage["prompt_tokens"]),
	)
	result.Usage.Completion = maxInt(result.Usage.Completion,
		number(usage["output_tokens"]), number(usage["completion_tokens"]),
	)
	result.Usage.Total = maxInt(result.Usage.Total, number(usage["total_tokens"]))
	result.Usage.Cached = maxInt(result.Usage.Cached,
		number(usage["cached_tokens"]), number(usage["cache_read_input_tokens"]),
		nestedNumber(usage, "input_tokens_details", "cached_tokens"),
	)
	result.Usage.CacheWrite = maxInt(result.Usage.CacheWrite,
		number(usage["cache_creation_input_tokens"]), number(usage["cache_write_tokens"]),
	)
	result.Usage.Reasoning = maxInt(result.Usage.Reasoning,
		number(usage["reasoning_tokens"]), nestedNumber(usage, "output_tokens_details", "reasoning_tokens"),
	)
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
func maxInt(values ...int64) int64 {
	var result int64
	for _, value := range values {
		if value > result {
			result = value
		}
	}
	return result
}

func Cost(price store.Price, usage store.Usage) int64 {
	uncached := usage.Prompt - usage.Cached
	if uncached < 0 {
		uncached = 0
	}
	return uncached*price.InputNanoUSDPerToken +
		usage.Cached*price.CachedInputNanoUSDPerToken +
		usage.Completion*price.OutputNanoUSDPerToken +
		usage.CacheWrite*price.CacheWriteNanoUSDPerToken +
		usage.Reasoning*price.ReasoningNanoUSDPerToken
}
