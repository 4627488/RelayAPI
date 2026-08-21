package relaybridge

import (
	"context"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/constant"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/interfaces"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/translator"
	codexchat "github.com/router-for-me/CLIProxyAPI/v7/internal/translator/codex/openai/chat-completions"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/translator/translator"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func init() {
	// Official CPA only registers Responses → Chat Completions. Codex clients
	// that hit Bailian with upstream_api=auto|responses need the reverse.
	translator.Register(
		constant.OpenAI,
		constant.OpenaiResponse,
		convertOpenAIChatCompletionsRequestToOpenAIResponses,
		interfaces.TranslateResponse{
			Stream:    convertOpenAIResponsesResponseToOpenAIChatCompletions,
			NonStream: convertOpenAIResponsesResponseToOpenAIChatCompletionsNonStream,
		},
	)
}

func convertOpenAIChatCompletionsRequestToOpenAIResponses(modelName string, inputRawJSON []byte, stream bool) []byte {
	out := codexchat.ConvertOpenAIRequestToCodex(modelName, inputRawJSON, stream)
	out, _ = sjson.DeleteBytes(out, "include")
	root := gjson.ParseBytes(inputRawJSON)

	if !root.Get("reasoning_effort").Exists() {
		out, _ = sjson.DeleteBytes(out, "reasoning")
	}
	if !root.Get("parallel_tool_calls").Exists() {
		out, _ = sjson.DeleteBytes(out, "parallel_tool_calls")
	}
	for _, field := range []string{"temperature", "top_p", "service_tier", "store", "user", "metadata"} {
		if value := root.Get(field); value.Exists() {
			out, _ = sjson.SetBytes(out, field, value.Value())
		}
	}
	if value := root.Get("max_completion_tokens"); value.Exists() {
		out, _ = sjson.SetBytes(out, "max_output_tokens", value.Value())
	} else if value = root.Get("max_tokens"); value.Exists() {
		out, _ = sjson.SetBytes(out, "max_output_tokens", value.Value())
	}
	return out
}

func convertOpenAIResponsesResponseToOpenAIChatCompletions(ctx context.Context, modelName string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) [][]byte {
	return codexchat.ConvertCodexResponseToOpenAI(ctx, modelName, originalRequestRawJSON, requestRawJSON, rawJSON, param)
}

func convertOpenAIResponsesResponseToOpenAIChatCompletionsNonStream(ctx context.Context, modelName string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) []byte {
	if gjson.GetBytes(rawJSON, "type").String() != "response.completed" && gjson.GetBytes(rawJSON, "type").String() != "response.incomplete" {
		wrapped := []byte(`{"type":"response.completed","response":{}}`)
		wrapped, _ = sjson.SetRawBytes(wrapped, "response", rawJSON)
		rawJSON = wrapped
	}
	return codexchat.ConvertCodexResponseToOpenAINonStream(ctx, modelName, originalRequestRawJSON, requestRawJSON, rawJSON, param)
}
