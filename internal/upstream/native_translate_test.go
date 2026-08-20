package upstream

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestResponsesToChatMergesParallelToolsAndKeepsCallIDs(t *testing.T) {
	payload, err := responsesToChatRequest([]byte(`{
		"model":"kimi","instructions":"be exact",
		"input":[
			{"type":"function_call","call_id":"call_a","name":"shell","arguments":"{\"cmd\":\"pwd\"}"},
			{"type":"function_call","call_id":"call_b","name":"read","arguments":"{\"path\":\"a\"}"},
			{"type":"message","role":"user","content":"later"},
			{"type":"function_call_output","call_id":"call_a","output":"ok-a"},
			{"type":"function_call_output","call_id":"call_b","output":"ok-b"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	messages := asAnySlice(body["messages"])
	if len(messages) != 5 {
		t.Fatalf("messages = %#v", messages)
	}
	system, assistant, firstTool, secondTool, later := messages[0].(map[string]any), messages[1].(map[string]any), messages[2].(map[string]any), messages[3].(map[string]any), messages[4].(map[string]any)
	if system["role"] != "system" || assistant["role"] != "assistant" || later["role"] != "user" || later["content"] != "later" {
		t.Fatalf("order = %#v", messages)
	}
	calls := asAnySlice(assistant["tool_calls"])
	if len(calls) != 2 || calls[0].(map[string]any)["id"] != "call_a" || calls[1].(map[string]any)["id"] != "call_b" {
		t.Fatalf("tool_calls = %#v", calls)
	}
	if firstTool["tool_call_id"] != "call_a" || secondTool["tool_call_id"] != "call_b" {
		t.Fatalf("outputs = %#v %#v", firstTool, secondTool)
	}
}

func TestResponsesToChatMapsReasoningAndStructuredOutput(t *testing.T) {
	payload, err := responsesToChatRequest([]byte(`{
		"model":"kimi",
		"text":{"format":{"type":"json_schema","name":"result","schema":{"type":"object"}}},
		"input":[
			{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},
			{"type":"message","role":"developer","content":"hint"},
			{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,xx","detail":"original"}]}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	format := body["response_format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("response_format = %#v", format)
	}
	messages := asAnySlice(body["messages"])
	if messages[0].(map[string]any)["reasoning_content"] != "think" || messages[1].(map[string]any)["role"] != "user" {
		t.Fatalf("messages = %#v", messages)
	}
	parts := asAnySlice(messages[2].(map[string]any)["content"])
	image := parts[0].(map[string]any)["image_url"].(map[string]any)
	if image["detail"] != "high" {
		t.Fatalf("image = %#v", image)
	}
}

func TestChatToResponsesMapsReasoningAndResponseFormat(t *testing.T) {
	payload, err := chatToResponsesRequest([]byte(`{
		"model":"gpt","reasoning_effort":"high","response_format":{"type":"json_object"},
		"messages":[
			{"role":"assistant","content":"","reasoning_content":"think","tool_calls":[{"id":"call_1","type":"function","function":{"name":"shell","arguments":"{}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"ok"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body["text"].(map[string]any)["format"].(map[string]any)["type"] != "json_object" {
		t.Fatalf("text = %#v", body["text"])
	}
	if body["reasoning"].(map[string]any)["effort"] != "high" {
		t.Fatalf("reasoning = %#v", body["reasoning"])
	}
	input := asAnySlice(body["input"])
	if input[0].(map[string]any)["type"] != "reasoning" || input[1].(map[string]any)["type"] != "function_call" || input[2].(map[string]any)["call_id"] != "call_1" {
		t.Fatalf("input = %#v", input)
	}
}

func TestNonStreamFinishReasonFollowsToolCallsAndIncomplete(t *testing.T) {
	chat := responsesToChatResponse([]byte(`{"id":"resp_1","status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{}"}]}`), "gpt")
	if !strings.Contains(string(chat), `"finish_reason":"tool_calls"`) {
		t.Fatalf("chat = %s", chat)
	}
	responses := chatToResponsesResponse([]byte(`{"id":"chat_1","choices":[{"finish_reason":"length","message":{"role":"assistant","content":"cut"}}]}`), "gpt")
	if !strings.Contains(string(responses), `"status":"incomplete"`) || !strings.Contains(string(responses), `"max_output_tokens"`) {
		t.Fatalf("responses = %s", responses)
	}
}

func TestChatStreamCompletesOnDoneWithoutFinishReason(t *testing.T) {
	source := strings.Join([]string{
		`data: {"id":"chat_1","model":"kimi","choices":[{"delta":{"reasoning_content":"think ","content":"hi"}}]}`,
		``, `data: [DONE]`, ``,
	}, "\n")
	var output bytes.Buffer
	if err := translateStream(&output, strings.NewReader(source), "chat-to-responses", "fallback"); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, event := range []string{"response.created", "response.reasoning_summary_text.delta", "response.output_text.delta", "response.completed"} {
		if !strings.Contains(text, `event: `+event) {
			t.Fatalf("missing %s in %s", event, text)
		}
	}
}

func TestResponsesStreamMapsReasoningToChat(t *testing.T) {
	source := strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt"}}`, ``,
		`data: {"type":"response.reasoning_summary_text.delta","delta":"think"}`, ``,
		`data: {"type":"response.output_text.delta","delta":"hi"}`, ``,
		`data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`, ``,
	}, "\n")
	var output bytes.Buffer
	if err := translateStream(&output, strings.NewReader(source), "responses-to-chat", "gpt"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"reasoning_content":"think"`) || !strings.Contains(output.String(), `"content":"hi"`) {
		t.Fatalf("chat stream = %s", output.String())
	}
}

func TestKimiCustomToolIsRestoredAfterChatRoundTrip(t *testing.T) {
	refs := customToolRefsFromResponses([]byte(`{"tools":[{"type":"custom","name":"apply_patch"}]}`))
	restorer := newToolResponseRestorer(refs)
	payload := chatToResponsesResponse([]byte(`{"id":"chat_1","choices":[{"message":{"tool_calls":[{"id":"call_1","function":{"name":"apply_patch","arguments":"{\"input\":\"patch\"}"}}]}}]}`), "kimi")
	restored := restorer.restore(payload)
	if !strings.Contains(string(restored), `"type":"custom_tool_call"`) || !strings.Contains(string(restored), `"input":"patch"`) {
		t.Fatalf("restored = %s", restored)
	}
}
