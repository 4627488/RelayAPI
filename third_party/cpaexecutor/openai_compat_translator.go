package relaybridge

import (
	"context"

	codexclaude "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/claude"
	codexchat "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/openai/chat-completions"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func init() {
	// Official CPA only registers Responses → Chat Completions. Codex clients
	// that hit Bailian with upstream_api=auto|responses need the reverse.
	builtin.Registry().Register(
		sdktranslator.FormatOpenAI,
		sdktranslator.FormatOpenAIResponse,
		convertOpenAIChatCompletionsRequestToOpenAIResponses,
		sdktranslator.ResponseTransform{
			Stream:    convertOpenAIResponsesResponseToOpenAIChatCompletions,
			NonStream: convertOpenAIResponsesResponseToOpenAIChatCompletionsNonStream,
		},
	)
	builtin.Registry().Register(
		sdktranslator.FormatClaude,
		sdktranslator.FormatOpenAIResponse,
		convertClaudeRequestToOpenAIResponses,
		sdktranslator.ResponseTransform{
			Stream:    codexclaude.ConvertCodexResponseToClaude,
			NonStream: convertOpenAIResponsesResponseToClaudeNonStream,
		},
	)
}

func convertClaudeRequestToOpenAIResponses(model string, body []byte, stream bool) ([]byte, error) {
	out, err := codexclaude.ConvertClaudeRequestToCodex(model, body, stream)
	if err != nil {
		return nil, err
	}
	out, _ = sjson.DeleteBytes(out, "include")
	out, _ = sjson.SetBytes(out, "stream", stream)
	root := gjson.ParseBytes(body)
	if !root.Get("thinking").Exists() && !root.Get("output_config.effort").Exists() {
		out, _ = sjson.DeleteBytes(out, "reasoning")
	}
	if limit := root.Get("max_tokens"); limit.Exists() {
		out, _ = sjson.SetBytes(out, "max_output_tokens", limit.Value())
	}
	for _, field := range []string{"temperature", "top_p"} {
		if value := root.Get(field); value.Exists() {
			out, _ = sjson.SetBytes(out, field, value.Value())
		}
	}
	return out, nil
}

func convertOpenAIResponsesResponseToClaudeNonStream(ctx context.Context, model string, original, request, response []byte, param *any) []byte {
	if gjson.GetBytes(response, "type").String() != "response.completed" && gjson.GetBytes(response, "type").String() != "response.incomplete" {
		wrapped := []byte(`{"type":"response.completed","response":{}}`)
		wrapped, _ = sjson.SetRawBytes(wrapped, "response", response)
		response = wrapped
	}
	return codexclaude.ConvertCodexResponseToClaudeNonStream(ctx, model, original, request, response, param)
}

func convertOpenAIChatCompletionsRequestToOpenAIResponses(modelName string, inputRawJSON []byte, stream bool) ([]byte, error) {
	// Dispatching through the SDK registry here would run plugin hooks again
	// inside the outer Responses translation. Reuse only the built-in transform.
	out, err := codexchat.ConvertOpenAIRequestToCodex(modelName, inputRawJSON, stream)
	if err != nil {
		return nil, err
	}
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
	return out, nil
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
