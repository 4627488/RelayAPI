package billing

import (
	"math"
	"testing"

	"github.com/4627488/RelayAPI/internal/pricing"
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
			name:    "bailian chat cache details",
			payload: `{"id":"chat_1","usage":{"prompt_tokens":1200,"completion_tokens":20,"total_tokens":1220,"prompt_tokens_details":{"cached_tokens":900}}}`,
			want:    store.Usage{Prompt: 1200, Completion: 20, Cached: 900, Total: 1220},
		},
		{
			name:    "anthropic messages SSE",
			payload: "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":13,\"output_tokens\":1,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":2}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
			want:    store.Usage{Prompt: 18, Completion: 7, Cached: 5, CacheWrite: 2, Total: 27},
		},
		{
			name:    "gemini native",
			payload: `{"responseId":"gem_1","usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":8,"totalTokenCount":31,"cachedContentTokenCount":4,"thoughtsTokenCount":3}}`,
			want:    store.Usage{Prompt: 20, Completion: 8, Cached: 4, Reasoning: 3, Total: 31},
		},
		{
			name:    "openai image usage",
			payload: `{"usage":{"input_tokens":110,"output_tokens":196,"total_tokens":306,"input_tokens_details":{"text_tokens":10,"image_tokens":100},"output_tokens_details":{"image_tokens":196}}}`,
			want:    store.Usage{Prompt: 110, Completion: 196, ImageInput: 100, ImageOutput: 196, Total: 306},
		},
		{
			name:    "gemini image modalities",
			payload: `{"usageMetadata":{"promptTokenCount":570,"candidatesTokenCount":1120,"totalTokenCount":1690,"promptTokensDetails":[{"modality":"TEXT","tokenCount":10},{"modality":"IMAGE","tokenCount":560}],"candidatesTokensDetails":[{"modality":"IMAGE","tokenCount":1120}]}}`,
			want:    store.Usage{Prompt: 570, Completion: 1120, ImageInput: 560, ImageOutput: 1120, Total: 1690},
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

func TestKimiMessagesCacheUsageIsBilledAsSeparateInput(t *testing.T) {
	result := ParseResponse([]byte(`{"type":"message_start","message":{"id":"msg_kimi","usage":{"input_tokens":475,"output_tokens":690,"cache_read_input_tokens":218880,"cache_creation_input_tokens":0,"total_tokens":1165}}}`))
	wantUsage := store.Usage{Prompt: 219355, Completion: 690, Cached: 218880, Total: 220045}
	if !result.Found || result.Usage != wantUsage {
		t.Fatalf("usage = %+v, want %+v", result.Usage, wantUsage)
	}
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 3000, CachedInputNanoUSDPerToken: 300,
		OutputNanoUSDPerToken: 15000,
	}}
	if got, want := Cost(price, result.Usage), int64(77_439_000); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestParseResponseServiceTier(t *testing.T) {
	result := ParseResponse([]byte(`{"response":{"service_tier":"priority","usage":{"input_tokens":1,"output_tokens":1}}}`))
	if result.ResponseServiceTier != "priority" {
		t.Fatalf("response service tier = %q", result.ResponseServiceTier)
	}
}

func TestCostAvoidsChargingCachedInputTwice(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 4,
		ReasoningNanoUSDPerToken: 3,
	},
	}
	usage := store.Usage{Prompt: 10, Completion: 5, Cached: 4, CacheWrite: 2, Reasoning: 1}
	if got, want := Cost(price, usage), int64(159); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestCostChargesSeparatelyReportedReasoning(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20, ReasoningNanoUSDPerToken: 3,
	}}
	usage := store.Usage{Prompt: 10, Completion: 5, Reasoning: 2, Total: 17}
	if got, want := Cost(price, usage), int64(206); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestCostChargesImageAndTextTokensAtSeparateRates(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 5, CachedInputNanoUSDPerToken: 1,
		ImageInputNanoUSDPerToken: 8, CachedImageInputNanoUSDPerToken: 2,
		ImageOutputNanoUSDPerToken: 30,
	}}
	usage := store.Usage{
		Prompt: 110, Cached: 15, ImageInput: 100, CachedImageInput: 10,
		Completion: 196, ImageOutput: 196, Total: 306,
	}
	// text: 5 uncached + 5 cached; image input: 90 uncached + 10 cached;
	// image output: 196.
	if got, want := Cost(price, usage), int64(6_650); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestImagePricingRequiresImageOutputUsage(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{ImageOutputNanoUSDPerToken: 30}}
	if UsageComplete(price, store.Usage{Completion: 196}) {
		t.Fatal("aggregate completion tokens must not be accepted as image usage")
	}
	if !UsageComplete(price, store.Usage{Completion: 196, ImageOutput: 196}) {
		t.Fatal("image output usage should be complete")
	}
}

func TestCostSaturatesInsteadOfOverflowing(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{OutputNanoUSDPerToken: 2}}
	usage := store.Usage{Completion: math.MaxInt64, Total: math.MaxInt64}
	if got := Cost(price, usage); got != math.MaxInt64 {
		t.Fatalf("cost = %d, want MaxInt64", got)
	}
}
