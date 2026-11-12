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
			want:    store.Usage{Input: 7, Output: 4, CacheRead: 3, Reasoning: 2, Total: 11},
		},
		{
			name:    "bailian chat cache details",
			payload: `{"id":"chat_1","usage":{"prompt_tokens":1200,"completion_tokens":20,"total_tokens":1220,"prompt_tokens_details":{"cached_tokens":900}}}`,
			want:    store.Usage{Input: 300, Output: 20, CacheRead: 900, Total: 320},
		},
		{
			name:    "openai image usage",
			payload: `{"usage":{"input_tokens":110,"output_tokens":196,"total_tokens":306,"input_tokens_details":{"text_tokens":10,"image_tokens":100},"output_tokens_details":{"image_tokens":196}}}`,
			want:    store.Usage{Input: 110, Output: 196, ImageInput: 100, ImageOutput: 196, Total: 306},
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
	wantUsage := store.Usage{Input: 475, Output: 690, CacheRead: 218880, Total: 1165}
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

func TestParseResponseModelFromUpstreamShapes(t *testing.T) {
	tests := []struct {
		name, payload, want string
	}{
		{"responses JSON", `{"id":"resp_1","model":"gpt-returned","usage":{"input_tokens":1}}`, "gpt-returned"},
		{"chat JSON", `{"id":"chat_1","model":"grok-returned","usage":{"prompt_tokens":1}}`, "grok-returned"},
		{"responses SSE", "data: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-created\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-completed\",\"usage\":{\"input_tokens\":1}}}\n\n", "gpt-completed"},
		{"created only", "data: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-created\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1}}}\n\n", "gpt-created"},
		{"missing model", `{"usage":{"input_tokens":1}}`, ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ParseResponse([]byte(test.payload)).Model; got != test.want {
				t.Fatalf("model = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCostAvoidsChargingCachedInputTwice(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20,
		CachedInputNanoUSDPerToken: 2, CacheWriteNanoUSDPerToken: 4,
		ReasoningNanoUSDPerToken: 3,
	},
	}
	usage := store.Usage{Input: 6, Output: 5, CacheRead: 4, CacheWrite: 2, Reasoning: 1}
	if got, want := Cost(price, usage), int64(176); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestCostNeverChargesReasoningTwice(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{
		InputNanoUSDPerToken: 10, OutputNanoUSDPerToken: 20, ReasoningNanoUSDPerToken: 3,
	}}
	usage := store.Usage{Input: 10, Output: 5, Reasoning: 2, Total: 17}
	if got, want := Cost(price, usage), int64(200); got != want {
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
		Input: 95, CacheRead: 15, ImageInput: 100, CachedImageInput: 10,
		Output: 196, ImageOutput: 196, Total: 306,
	}
	// text: 5 uncached + 5 cached; image input: 90 uncached + 10 cached;
	// image output: 196.
	if got, want := Cost(price, usage), int64(6_650); got != want {
		t.Fatalf("cost = %d, want %d", got, want)
	}
}

func TestImagePricingRequiresImageOutputUsage(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{ImageOutputNanoUSDPerToken: 30}}
	if UsageComplete(price, store.Usage{Output: 196}) {
		t.Fatal("aggregate completion tokens must not be accepted as image usage")
	}
	if !UsageComplete(price, store.Usage{Output: 196, ImageOutput: 196}) {
		t.Fatal("image output usage should be complete")
	}
}

func TestCostSaturatesInsteadOfOverflowing(t *testing.T) {
	price := pricing.SnapshotPrice{Price: pricing.Price{OutputNanoUSDPerToken: 2}}
	usage := store.Usage{Output: math.MaxInt64, Total: math.MaxInt64}
	if got := Cost(price, usage); got != math.MaxInt64 {
		t.Fatalf("cost = %d, want MaxInt64", got)
	}
}

func TestMagpieProtocolCacheTTLandGeminiReasoning(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    store.Usage
	}{
		{`{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":300,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_1h_input_tokens":60}}}`, store.Usage{Input: 100, Output: 50, CacheRead: 300, CacheWrite: 100, CacheWrite1h: 60, Total: 150}},
		{`{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":80,"candidatesTokenCount":10,"thoughtsTokenCount":20}}`, store.Usage{Input: 20, Output: 30, CacheRead: 80, Reasoning: 20, Total: 50}},
		{`{"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":20}}}`, store.Usage{Input: 20, Output: 50, CacheRead: 80, Reasoning: 20, Total: 70}},
	} {
		got := ParseResponse([]byte(tc.payload))
		if !got.Found || got.Usage != tc.want {
			t.Fatalf("%s: got %+v want %+v", tc.payload, got, tc.want)
		}
	}
	if ParseResponse([]byte(`{"usage":{}}`)).Found {
		t.Fatal("empty object is not explicit zero usage")
	}
}

func TestMalformedOrPartialUsageDoesNotBecomeACharge(t *testing.T) {
	price := &store.ResolvedPrice{Price: pricing.Price{InputNanoUSDPerToken: 1, OutputNanoUSDPerToken: 2}}
	for _, payload := range []string{`{"usage":{"input_tokens":100}}`, `{"usage":{"input_tokens":10,"output_tokens":5,"cached_tokens":100}}`, `{"usage":{"input_tokens":-1,"output_tokens":50}}`, `{"usage":{"input_tokens":"100","output_tokens":50}}`} {
		got := ParseResponse([]byte(payload))
		if assessment := Assess(got, price); assessment.Complete || assessment.CostNanoUSD != 0 {
			t.Fatalf("malformed usage charged: %s %+v", payload, got)
		}
	}
	var got Result
	Merge(&got, ParseResponse([]byte(`{"usage":{"input_tokens":100}}`)))
	Merge(&got, ParseResponse([]byte(`{"usage":{"output_tokens":50}}`)))
	if got.UsageQuality != "complete" || !Assess(got, price).Complete {
		t.Fatalf("split stream did not complete: %+v", got)
	}
}
