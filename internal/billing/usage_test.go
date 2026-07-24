package billing

import (
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestParseResponseProtocols(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    store.Usage
	}{
		{
			name:    "openai responses SSE",
			payload: "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"input_tokens_details\":{\"cached_tokens\":3},\"output_tokens_details\":{\"reasoning_tokens\":2}}}}\n\n",
			want:    store.Usage{Prompt: 10, Completion: 4, Cached: 3, Reasoning: 2, Total: 14},
		},
		{
			name:    "anthropic messages SSE",
			payload: "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":13,\"output_tokens\":1,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":2}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
			want:    store.Usage{Prompt: 13, Completion: 7, Cached: 5, CacheWrite: 2, Total: 20},
		},
		{
			name:    "gemini native",
			payload: `{"responseId":"gem_1","usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":8,"totalTokenCount":31,"cachedContentTokenCount":4,"thoughtsTokenCount":3}}`,
			want:    store.Usage{Prompt: 20, Completion: 8, Cached: 4, Reasoning: 3, Total: 31},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ParseResponse([]byte(test.payload))
			if !got.Found {
				t.Fatal("usage not found")
			}
			if got.Usage != test.want {
				t.Fatalf("usage = %+v, want %+v", got.Usage, test.want)
			}
		})
	}
}

func TestCostAvoidsChargingCachedInputTwice(t *testing.T) {
	price := store.Price{
		InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 4,
		ReasoningNanoUSDPerToken: 3,
	}
	usage := store.Usage{Prompt: 10, Completion: 5, Cached: 4, CacheWrite: 2, Reasoning: 1}
	if got, want := Cost(price, usage), int64(179); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}
