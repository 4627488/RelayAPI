package upstream

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

func responsesToChatRequest(payload []byte) ([]byte, error) {
	var source map[string]any
	if err := json.Unmarshal(payload, &source); err != nil {
		return nil, fmt.Errorf("invalid Responses request: %w", err)
	}
	target := copyKnown(source, "model", "stream", "temperature", "top_p", "seed", "stop", "user", "parallel_tool_calls", "service_tier")
	if format := responsesTextFormatToChat(source["text"]); format != nil {
		target["response_format"] = format
	}
	if limit, ok := source["max_output_tokens"]; ok {
		target["max_tokens"] = limit
	}
	if reasoning, ok := source["reasoning"].(map[string]any); ok {
		if effort := reasoning["effort"]; effort != nil {
			target["reasoning_effort"] = effort
		}
	}

	outputIDs := toolOutputCallIDs(source["input"])
	messages := make([]any, 0)
	pendingCalls := make([]any, 0)
	pendingIDs := make([]string, 0)
	awaiting := make(map[string]struct{})
	deferred := make([]any, 0)
	pendingReasoning := ""

	flushCalls := func() {
		if len(pendingCalls) == 0 {
			return
		}
		message := map[string]any{"role": "assistant", "tool_calls": pendingCalls}
		if pendingReasoning != "" {
			message["reasoning_content"] = pendingReasoning
			pendingReasoning = ""
		}
		messages = append(messages, message)
		for _, id := range pendingIDs {
			if id != "" {
				awaiting[id] = struct{}{}
			}
		}
		pendingCalls = pendingCalls[:0]
		pendingIDs = pendingIDs[:0]
	}
	appendRegular := func(message map[string]any) {
		if hasAwaitingToolOutput(awaiting, outputIDs) {
			deferred = append(deferred, message)
			return
		}
		messages = append(messages, message)
	}
	flushReasoning := func() {
		if pendingReasoning == "" {
			return
		}
		appendRegular(map[string]any{"role": "assistant", "content": "", "reasoning_content": pendingReasoning})
		pendingReasoning = ""
	}
	flushDeferred := func() {
		messages = append(messages, deferred...)
		deferred = deferred[:0]
	}

	if instructions, _ := source["instructions"].(string); instructions != "" {
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	switch input := source["input"].(type) {
	case string:
		messages = append(messages, map[string]any{"role": "user", "content": input})
	case []any:
		for _, raw := range input {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			kind := anyString(item["type"])
			if kind == "" && anyString(item["role"]) != "" {
				kind = "message"
			}
			if kind != "function_call" && kind != "custom_tool_call" {
				flushCalls()
			}
			switch kind {
			case "message":
				role := firstNonEmpty(anyString(item["role"]), "user")
				if role == "developer" {
					role = "user"
				}
				if role != "assistant" {
					flushReasoning()
				}
				message := map[string]any{"role": role, "content": responsesContentToChat(item["content"])}
				if role == "assistant" {
					if reasoning := firstNonEmpty(pendingReasoning, anyString(item["reasoning_content"])); reasoning != "" {
						message["reasoning_content"] = reasoning
						pendingReasoning = ""
					}
				}
				appendRegular(message)
			case "reasoning":
				pendingReasoning = joinReasoning(pendingReasoning, reasoningText(item))
			case "function_call", "custom_tool_call":
				pendingReasoning = joinReasoning(pendingReasoning, anyString(item["reasoning_content"]))
				id := toolCallID(anyString(item["call_id"]), anyString(item["id"]))
				name := qualifyToolName(anyString(item["namespace"]), anyString(item["name"]))
				arguments := firstNonEmpty(anyString(item["arguments"]), "{}")
				if kind == "custom_tool_call" {
					encoded, _ := json.Marshal(map[string]any{"input": item["input"]})
					arguments = string(encoded)
				}
				pendingCalls = append(pendingCalls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": arguments}})
				pendingIDs = append(pendingIDs, id)
			case "function_call_output", "custom_tool_call_output":
				id := toolCallID(anyString(item["call_id"]), anyString(item["id"]))
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": id, "content": stringifyContent(item["output"])})
				delete(awaiting, id)
				if !hasAwaitingToolOutput(awaiting, outputIDs) {
					flushDeferred()
				}
			}
		}
	}
	flushCalls()
	flushReasoning()
	flushDeferred()
	target["messages"] = messages

	tools := responsesToolsToChat(source["tools"])
	for _, raw := range asAnySlice(source["input"]) {
		if item, ok := raw.(map[string]any); ok && item["type"] == "additional_tools" {
			tools = append(tools, responsesToolsToChat(item["tools"])...)
		}
	}
	if len(tools) > 0 {
		target["tools"] = tools
	}
	if choice, ok := source["tool_choice"]; ok {
		target["tool_choice"] = chatToolChoice(choice)
	}
	return json.Marshal(target)
}

func responsesToolsToChat(value any) []any {
	result := make([]any, 0)
	var visit func(any, string)
	visit = func(value any, namespace string) {
		for _, raw := range asAnySlice(value) {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			kind := anyString(tool["type"])
			if kind == "namespace" {
				visit(tool["tools"], anyString(tool["name"]))
				continue
			}
			name := qualifyToolName(namespace, anyString(tool["name"]))
			parameters := tool["parameters"]
			if kind == "custom" {
				parameters = map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string"}}, "required": []any{"input"}, "additionalProperties": false}
			}
			if name != "" {
				result = append(result, map[string]any{"type": "function", "function": map[string]any{"name": name, "description": tool["description"], "parameters": parameters}})
			}
		}
	}
	visit(value, "")
	return result
}

func chatToResponsesRequest(payload []byte) ([]byte, error) {
	var source map[string]any
	if err := json.Unmarshal(payload, &source); err != nil {
		return nil, fmt.Errorf("invalid Chat Completions request: %w", err)
	}
	target := copyKnown(source, "model", "stream", "temperature", "top_p", "parallel_tool_calls", "service_tier", "user", "prompt_cache_key", "previous_response_id")
	if format := chatResponseFormatToResponses(source["response_format"]); format != nil {
		target["text"] = map[string]any{"format": format}
	}
	input := make([]any, 0)
	for _, raw := range asAnySlice(source["messages"]) {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := anyString(message["role"])
		if reasoning := firstNonEmpty(anyString(message["reasoning_content"]), anyString(message["reasoning"])); reasoning != "" && role != "tool" {
			input = append(input, map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": reasoning}}})
		}
		if role == "system" || role == "developer" {
			text := stringifyContent(message["content"])
			if current := anyString(target["instructions"]); current != "" {
				target["instructions"] = current + "\n\n" + text
			} else {
				target["instructions"] = text
			}
			continue
		}
		if role == "tool" {
			input = append(input, map[string]any{"type": "function_call_output", "call_id": firstNonEmpty(anyString(message["tool_call_id"]), generatedID("call")), "output": stringifyContent(message["content"])})
			continue
		}
		if hasResponsesMessageContent(message["content"]) {
			input = append(input, map[string]any{"type": "message", "role": role, "content": chatContentToResponses(message["content"], role)})
		}
		for _, rawCall := range asAnySlice(message["tool_calls"]) {
			call, _ := rawCall.(map[string]any)
			function, _ := call["function"].(map[string]any)
			input = append(input, map[string]any{"type": "function_call", "call_id": toolCallID(anyString(call["id"])), "name": function["name"], "arguments": firstNonEmpty(anyString(function["arguments"]), "{}")})
		}
	}
	target["input"] = input
	if max, ok := source["max_tokens"]; ok {
		target["max_output_tokens"] = max
	} else if max, ok := source["max_completion_tokens"]; ok {
		target["max_output_tokens"] = max
	}
	if effort, ok := source["reasoning_effort"]; ok {
		target["reasoning"] = map[string]any{"effort": effort}
	}
	if tools := chatToolsToResponses(source["tools"]); len(tools) > 0 {
		target["tools"] = tools
	}
	if choice, ok := source["tool_choice"]; ok {
		target["tool_choice"] = responsesToolChoice(choice)
	}
	return json.Marshal(target)
}

func chatToolsToResponses(value any) []any {
	result := make([]any, 0)
	for _, raw := range asAnySlice(value) {
		tool, _ := raw.(map[string]any)
		function, _ := tool["function"].(map[string]any)
		if function == nil {
			continue
		}
		result = append(result, map[string]any{"type": "function", "name": function["name"], "description": function["description"], "parameters": function["parameters"]})
	}
	return result
}

func chatToResponsesResponse(payload []byte, model string) []byte {
	var source map[string]any
	if json.Unmarshal(payload, &source) != nil {
		return payload
	}
	output := make([]any, 0)
	finish := ""
	for _, raw := range asAnySlice(source["choices"]) {
		choice, _ := raw.(map[string]any)
		finish = firstNonEmpty(anyString(choice["finish_reason"]), finish)
		message, _ := choice["message"].(map[string]any)
		if reasoning := firstNonEmpty(anyString(message["reasoning_content"]), anyString(message["reasoning"])); reasoning != "" {
			output = append(output, map[string]any{"id": generatedID("rs"), "type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": reasoning}}})
		}
		if text := stringifyContent(message["content"]); text != "" {
			output = append(output, map[string]any{"id": generatedID("msg"), "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}})
		}
		if refusal := anyString(message["refusal"]); refusal != "" {
			output = append(output, map[string]any{"id": generatedID("msg"), "type": "message", "status": "incomplete", "role": "assistant", "content": []any{map[string]any{"type": "refusal", "refusal": refusal}}})
		}
		for _, rawCall := range asAnySlice(message["tool_calls"]) {
			call, _ := rawCall.(map[string]any)
			function, _ := call["function"].(map[string]any)
			output = append(output, map[string]any{"id": generatedID("fc"), "type": "function_call", "status": "completed", "call_id": toolCallID(anyString(call["id"])), "name": function["name"], "arguments": firstNonEmpty(anyString(function["arguments"]), "{}")})
		}
	}
	status := "completed"
	if details, incomplete := incompleteDetails(finish); incomplete {
		status = "incomplete"
		_ = details
	}
	response := map[string]any{"id": firstNonEmpty(anyString(source["id"]), generatedID("resp")), "object": "response", "created_at": unixNumber(source["created"]), "status": status, "model": firstNonEmpty(anyString(source["model"]), model), "output": output, "parallel_tool_calls": true}
	if details, ok := incompleteDetails(finish); ok {
		response["incomplete_details"] = details
	}
	if usage, ok := source["usage"].(map[string]any); ok {
		response["usage"] = chatUsageToResponses(usage)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return payload
	}
	return encoded
}

func responsesToChatResponse(payload []byte, model string) []byte {
	var source map[string]any
	if json.Unmarshal(payload, &source) != nil {
		return payload
	}
	message := map[string]any{"role": "assistant", "content": ""}
	text := strings.Builder{}
	reasoning := strings.Builder{}
	toolCalls := make([]any, 0)
	for _, raw := range asAnySlice(source["output"]) {
		item, _ := raw.(map[string]any)
		switch item["type"] {
		case "reasoning":
			if value := reasoningText(item); value != "" {
				if reasoning.Len() > 0 {
					reasoning.WriteString("\n\n")
				}
				reasoning.WriteString(value)
			}
		case "message":
			for _, content := range asAnySlice(item["content"]) {
				part, _ := content.(map[string]any)
				switch part["type"] {
				case "output_text":
					text.WriteString(rawString(part["text"]))
				case "refusal":
					message["refusal"] = rawString(part["refusal"])
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{"id": toolCallID(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": firstNonEmpty(anyString(item["arguments"]), "{}")}})
		case "custom_tool_call":
			arguments, _ := json.Marshal(map[string]any{"input": item["input"]})
			toolCalls = append(toolCalls, map[string]any{"id": toolCallID(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": string(arguments)}})
		}
	}
	message["content"] = text.String()
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	finish := "stop"
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	} else if anyString(source["status"]) == "incomplete" {
		finish = "length"
	}
	target := map[string]any{"id": source["id"], "object": "chat.completion", "created": unixNumber(source["created_at"]), "model": firstNonEmpty(anyString(source["model"]), model), "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}}
	if usage, ok := source["usage"].(map[string]any); ok {
		target["usage"] = responsesUsageToChat(usage)
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return payload
	}
	return encoded
}

func translateStream(w io.Writer, source io.Reader, mode, model string) error {
	if mode == "chat-to-responses" {
		return translateChatStreamToResponses(w, source, model)
	}
	return translateResponsesStreamToChat(w, source, model)
}

func translateResponsesStreamToChat(w io.Writer, source io.Reader, fallbackModel string) error {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	responseID, model := generatedID("chatcmpl"), fallbackModel
	toolIndexes := make(map[int]int)
	customInputs := make(map[int]*strings.Builder)
	nextToolIndex := 0
	toolSeen := false
	finish := "stop"
	emit := func(delta map[string]any, finishReason any, usage any) error {
		chunk := map[string]any{
			"id":      responseID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finishReason}},
		}
		if usage != nil {
			chunk["usage"] = usage
		}
		encoded, err := json.Marshal(chunk)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "data: %s\n\n", encoded)
		return err
	}
	roleSent := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(data), &event) != nil {
			continue
		}
		if response, ok := event["response"].(map[string]any); ok {
			if id := anyString(response["id"]); id != "" {
				responseID = id
			}
			if current := anyString(response["model"]); current != "" {
				model = current
			}
			if anyString(response["status"]) == "incomplete" {
				finish = "length"
			}
		}
		if !roleSent {
			roleSent = true
			if err := emit(map[string]any{"role": "assistant", "content": ""}, nil, nil); err != nil {
				return err
			}
		}
		switch event["type"] {
		case "response.output_text.delta":
			if err := emit(map[string]any{"content": rawString(event["delta"])}, nil, nil); err != nil {
				return err
			}
		case "response.reasoning_summary_text.delta":
			if err := emit(map[string]any{"reasoning_content": rawString(event["delta"])}, nil, nil); err != nil {
				return err
			}
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" || item["type"] == "custom_tool_call" {
				outputIndex := intNumber(event["output_index"])
				index := nextToolIndex
				nextToolIndex++
				toolIndexes[outputIndex] = index
				toolSeen = true
				name, id := anyString(item["name"]), toolCallID(anyString(item["call_id"]), anyString(item["id"]))
				if item["type"] == "custom_tool_call" {
					builder := &strings.Builder{}
					builder.WriteString(rawString(item["input"]))
					customInputs[outputIndex] = builder
				}
				delta := map[string]any{"tool_calls": []any{map[string]any{"index": index, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": ""}}}}
				if err := emit(delta, nil, nil); err != nil {
					return err
				}
			}
		case "response.function_call_arguments.delta":
			index := toolIndexes[intNumber(event["output_index"])]
			delta := map[string]any{"tool_calls": []any{map[string]any{"index": index, "function": map[string]any{"arguments": rawString(event["delta"])}}}}
			if err := emit(delta, nil, nil); err != nil {
				return err
			}
		case "response.custom_tool_call_input.delta":
			outputIndex := intNumber(event["output_index"])
			if builder := customInputs[outputIndex]; builder != nil {
				builder.WriteString(rawString(event["delta"]))
			}
		case "response.custom_tool_call_input.done":
			outputIndex := intNumber(event["output_index"])
			index := toolIndexes[outputIndex]
			input := rawString(event["input"])
			if input == "" {
				if builder := customInputs[outputIndex]; builder != nil {
					input = builder.String()
				}
			}
			encoded, _ := json.Marshal(map[string]any{"input": input})
			delta := map[string]any{"tool_calls": []any{map[string]any{"index": index, "function": map[string]any{"arguments": string(encoded)}}}}
			if err := emit(delta, nil, nil); err != nil {
				return err
			}
		case "response.completed", "response.incomplete":
			if toolSeen {
				finish = "tool_calls"
			} else if event["type"] == "response.incomplete" {
				finish = "length"
			}
			var usage any
			if response, ok := event["response"].(map[string]any); ok {
				usage = responsesUsageToChat(response["usage"])
			}
			if err := emit(map[string]any{}, finish, usage); err != nil {
				return err
			}
			if _, err := io.WriteString(w, "data: [DONE]\n\n"); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func responsesUsageToChat(value any) map[string]any {
	usage, _ := value.(map[string]any)
	result := map[string]any{"prompt_tokens": numberOrZero(usage["input_tokens"]), "completion_tokens": numberOrZero(usage["output_tokens"]), "total_tokens": numberOrZero(usage["total_tokens"])}
	if details, ok := usage["output_tokens_details"].(map[string]any); ok && details["reasoning_tokens"] != nil {
		result["completion_tokens_details"] = map[string]any{"reasoning_tokens": details["reasoning_tokens"]}
	}
	return result
}

type chatStreamTool struct {
	Index                       int
	ID, CallID, Name, Arguments string
}

func translateChatStreamToResponses(w io.Writer, source io.Reader, fallbackModel string) error {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	responseID, model := "", fallbackModel
	messageID := generatedID("msg")
	reasoningID := generatedID("rs")
	created, messageAdded, contentAdded, reasoningAdded := false, false, false, false
	textValue := strings.Builder{}
	reasoningValue := strings.Builder{}
	tools := make(map[int]*chatStreamTool)
	sequence := 0
	var finalOutput []any
	var latestUsage any
	finishReason := ""
	terminalReady, completed := false, false
	emit := func(event map[string]any) error {
		event["sequence_number"] = sequence
		sequence++
		encoded, err := json.Marshal(event)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], encoded)
		return err
	}
	ensureCreated := func(createdAt any) error {
		if created {
			return nil
		}
		created = true
		if responseID == "" {
			responseID = generatedID("resp")
		}
		return emit(map[string]any{"type": "response.created", "response": map[string]any{"id": responseID, "object": "response", "created_at": unixNumber(createdAt), "status": "in_progress", "model": model, "output": []any{}}})
	}
	finalize := func() error {
		if terminalReady {
			return nil
		}
		output := make([]any, 0, 2+len(tools))
		if reasoningAdded {
			if err := emit(map[string]any{"type": "response.reasoning_summary_text.done", "item_id": reasoningID, "output_index": 0, "summary_index": 0, "text": reasoningValue.String()}); err != nil {
				return err
			}
			item := map[string]any{"id": reasoningID, "type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": reasoningValue.String()}}}
			if err := emit(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item}); err != nil {
				return err
			}
			output = append(output, item)
		}
		messageIndex := boolInt(reasoningAdded)
		if messageAdded {
			if err := emit(map[string]any{"type": "response.output_text.done", "item_id": messageID, "output_index": messageIndex, "content_index": 0, "text": textValue.String()}); err != nil {
				return err
			}
			part := map[string]any{"type": "output_text", "text": textValue.String(), "annotations": []any{}}
			if err := emit(map[string]any{"type": "response.content_part.done", "item_id": messageID, "output_index": messageIndex, "content_index": 0, "part": part}); err != nil {
				return err
			}
			item := map[string]any{"id": messageID, "type": "message", "status": "completed", "role": "assistant", "content": []any{part}}
			if err := emit(map[string]any{"type": "response.output_item.done", "output_index": messageIndex, "item": item}); err != nil {
				return err
			}
			output = append(output, item)
		}
		for index := 0; index < len(tools); index++ {
			tool := tools[index]
			if tool == nil {
				continue
			}
			outputIndex := tool.Index + boolInt(messageAdded) + boolInt(reasoningAdded)
			if err := emit(map[string]any{"type": "response.function_call_arguments.done", "item_id": tool.ID, "output_index": outputIndex, "arguments": tool.Arguments}); err != nil {
				return err
			}
			item := map[string]any{"id": tool.ID, "type": "function_call", "status": "completed", "call_id": tool.CallID, "name": tool.Name, "arguments": tool.Arguments}
			if err := emit(map[string]any{"type": "response.output_item.done", "output_index": outputIndex, "item": item}); err != nil {
				return err
			}
			output = append(output, item)
		}
		finalOutput = output
		terminalReady = true
		return nil
	}
	complete := func() error {
		if err := finalize(); err != nil {
			return err
		}
		if completed {
			return nil
		}
		completed = true
		event := "response.completed"
		status := "completed"
		response := map[string]any{"id": responseID, "object": "response", "status": status, "model": model, "output": finalOutput, "usage": chatUsageToResponses(latestUsage)}
		if details, ok := incompleteDetails(finishReason); ok {
			event = "response.incomplete"
			response["status"] = "incomplete"
			response["incomplete_details"] = details
		}
		return emit(map[string]any{"type": event, "response": response})
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			if err := complete(); err != nil {
				return err
			}
			continue
		}
		var chunk map[string]any
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if responseID == "" {
			responseID = firstNonEmpty(anyString(chunk["id"]), generatedID("resp"))
		}
		if current := anyString(chunk["model"]); current != "" {
			model = current
		}
		if chunk["usage"] != nil {
			latestUsage = chunk["usage"]
		}
		if err := ensureCreated(chunk["created"]); err != nil {
			return err
		}
		for _, raw := range asAnySlice(chunk["choices"]) {
			choice, _ := raw.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if reasoning := firstNonEmpty(rawString(delta["reasoning_content"]), rawString(delta["reasoning"])); reasoning != "" {
				if !reasoningAdded {
					reasoningAdded = true
					if err := emit(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"id": reasoningID, "type": "reasoning", "status": "in_progress", "summary": []any{}}}); err != nil {
						return err
					}
					if err := emit(map[string]any{"type": "response.reasoning_summary_part.added", "item_id": reasoningID, "output_index": 0, "summary_index": 0, "part": map[string]any{"type": "summary_text", "text": ""}}); err != nil {
						return err
					}
				}
				reasoningValue.WriteString(reasoning)
				if err := emit(map[string]any{"type": "response.reasoning_summary_text.delta", "item_id": reasoningID, "output_index": 0, "summary_index": 0, "delta": reasoning}); err != nil {
					return err
				}
			}
			if content := rawString(delta["content"]); content != "" {
				outputIndex := boolInt(reasoningAdded)
				if !messageAdded {
					messageAdded = true
					if err := emit(map[string]any{"type": "response.output_item.added", "output_index": outputIndex, "item": map[string]any{"id": messageID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}}); err != nil {
						return err
					}
				}
				if !contentAdded {
					contentAdded = true
					if err := emit(map[string]any{"type": "response.content_part.added", "item_id": messageID, "output_index": outputIndex, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}}); err != nil {
						return err
					}
				}
				textValue.WriteString(content)
				if err := emit(map[string]any{"type": "response.output_text.delta", "item_id": messageID, "output_index": outputIndex, "content_index": 0, "delta": content}); err != nil {
					return err
				}
			}
			for _, rawCall := range asAnySlice(delta["tool_calls"]) {
				call, _ := rawCall.(map[string]any)
				index := intNumber(call["index"])
				tool := tools[index]
				function, _ := call["function"].(map[string]any)
				if tool == nil {
					id := toolCallID(anyString(call["id"]))
					tool = &chatStreamTool{Index: index, ID: id, CallID: id, Name: anyString(function["name"])}
					tools[index] = tool
					outputIndex := index + boolInt(messageAdded) + boolInt(reasoningAdded)
					if err := emit(map[string]any{"type": "response.output_item.added", "output_index": outputIndex, "item": map[string]any{"id": tool.ID, "type": "function_call", "status": "in_progress", "call_id": tool.CallID, "name": tool.Name, "arguments": ""}}); err != nil {
						return err
					}
				}
				if name := anyString(function["name"]); name != "" {
					tool.Name = name
				}
				arguments := rawString(function["arguments"])
				if arguments != "" {
					tool.Arguments += arguments
					if err := emit(map[string]any{"type": "response.function_call_arguments.delta", "item_id": tool.ID, "output_index": tool.Index + boolInt(messageAdded) + boolInt(reasoningAdded), "delta": arguments}); err != nil {
						return err
					}
				}
			}
			if reason := anyString(choice["finish_reason"]); reason != "" {
				finishReason = reason
				if err := finalize(); err != nil {
					return err
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return complete()
}

func chatUsageToResponses(value any) map[string]any {
	usage, _ := value.(map[string]any)
	result := map[string]any{"input_tokens": numberOrZero(usage["prompt_tokens"]), "output_tokens": numberOrZero(usage["completion_tokens"]), "total_tokens": numberOrZero(usage["total_tokens"])}
	if details, ok := firstMap(usage["completion_tokens_details"], usage["output_tokens_details"]); ok {
		if details["reasoning_tokens"] != nil {
			result["output_tokens_details"] = map[string]any{"reasoning_tokens": details["reasoning_tokens"]}
		}
	}
	return result
}

func firstMap(values ...any) (map[string]any, bool) {
	for _, value := range values {
		if object, ok := value.(map[string]any); ok {
			return object, true
		}
	}
	return nil, false
}

func intNumber(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case int:
		return typed
	default:
		return 0
	}
}

func numberOrZero(value any) any {
	if value == nil {
		return 0
	}
	return value
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func copyKnown(source map[string]any, keys ...string) map[string]any {
	target := make(map[string]any)
	for _, key := range keys {
		if value, exists := source[key]; exists {
			target[key] = value
		}
	}
	return target
}

func responsesContentToChat(value any) any {
	if text, ok := value.(string); ok {
		return text
	}
	result := make([]any, 0)
	for _, raw := range asAnySlice(value) {
		part, _ := raw.(map[string]any)
		switch part["type"] {
		case "input_text", "output_text":
			result = append(result, map[string]any{"type": "text", "text": part["text"]})
		case "input_image":
			image := map[string]any{"url": part["image_url"]}
			if detail := chatImageDetail(part["detail"]); detail != "" {
				image["detail"] = detail
			}
			result = append(result, map[string]any{"type": "image_url", "image_url": image})
		}
	}
	return result
}

func hasResponsesMessageContent(value any) bool {
	if stringifyContent(value) != "" {
		return true
	}
	for _, raw := range asAnySlice(value) {
		part, _ := raw.(map[string]any)
		switch anyString(part["type"]) {
		case "image_url", "input_image":
			return true
		}
	}
	return false
}

func chatContentToResponses(value any, role string) any {
	if text, ok := value.(string); ok {
		return []any{map[string]any{"type": map[bool]string{true: "output_text", false: "input_text"}[role == "assistant"], "text": text}}
	}
	result := make([]any, 0)
	for _, raw := range asAnySlice(value) {
		part, _ := raw.(map[string]any)
		switch part["type"] {
		case "text":
			result = append(result, map[string]any{"type": "input_text", "text": part["text"]})
		case "image_url":
			image, _ := part["image_url"].(map[string]any)
			item := map[string]any{"type": "input_image", "image_url": image["url"]}
			if detail := chatImageDetail(image["detail"]); detail != "" {
				item["detail"] = detail
			}
			result = append(result, item)
		}
	}
	return result
}

func chatToolChoice(value any) any {
	choice, ok := value.(map[string]any)
	if !ok {
		return value
	}
	if function, ok := choice["function"].(map[string]any); ok {
		return map[string]any{"type": "function", "function": map[string]any{"name": function["name"]}}
	}
	return choice
}

func responsesToolChoice(value any) any {
	choice, ok := value.(map[string]any)
	if !ok {
		return value
	}
	if function, ok := choice["function"].(map[string]any); ok {
		return map[string]any{"type": "function", "name": function["name"]}
	}
	return choice
}

func stringifyContent(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	var builder strings.Builder
	for _, raw := range asAnySlice(value) {
		part, _ := raw.(map[string]any)
		if text := rawString(part["text"]); text != "" {
			builder.WriteString(text)
		}
	}
	if builder.Len() > 0 {
		return builder.String()
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func anyString(value any) string { text, _ := value.(string); return strings.TrimSpace(text) }
func rawString(value any) string { text, _ := value.(string); return text }
func unixNumber(value any) any {
	if value == nil {
		return time.Now().Unix()
	}
	return value
}
func generatedID(prefix string) string { return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano()) }

func toolCallID(values ...string) string {
	if id := firstNonEmpty(values...); id != "" {
		return id
	}
	return generatedID("call")
}

func qualifyToolName(namespace, name string) string {
	name = strings.TrimSpace(name)
	namespace = strings.TrimSpace(namespace)
	if namespace != "" && name != "" && !strings.Contains(name, "__") {
		return namespace + "__" + name
	}
	return name
}

func toolOutputCallIDs(input any) map[string]struct{} {
	ids := make(map[string]struct{})
	for _, raw := range asAnySlice(input) {
		item, _ := raw.(map[string]any)
		kind := anyString(item["type"])
		if kind != "function_call_output" && kind != "custom_tool_call_output" {
			continue
		}
		if id := firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids
}

func hasAwaitingToolOutput(awaiting, outputs map[string]struct{}) bool {
	for id := range awaiting {
		if _, ok := outputs[id]; ok {
			return true
		}
	}
	return false
}

func reasoningText(item map[string]any) string {
	if text := anyString(item["reasoning_content"]); text != "" {
		return text
	}
	var builder strings.Builder
	for _, raw := range asAnySlice(item["summary"]) {
		part, _ := raw.(map[string]any)
		if anyString(part["type"]) == "summary_text" || anyString(part["type"]) == "" {
			if text := rawString(part["text"]); text != "" {
				builder.WriteString(text)
			}
		}
	}
	return builder.String()
}

func joinReasoning(existing, incoming string) string {
	existing, incoming = strings.TrimSpace(existing), strings.TrimSpace(incoming)
	switch {
	case existing == "":
		return incoming
	case incoming == "" || existing == incoming:
		return existing
	default:
		return existing + "\n\n" + incoming
	}
}

func responsesTextFormatToChat(value any) map[string]any {
	text, _ := value.(map[string]any)
	format, _ := text["format"].(map[string]any)
	switch anyString(format["type"]) {
	case "json_object", "text":
		return map[string]any{"type": format["type"]}
	case "json_schema":
		schema := map[string]any{}
		for _, key := range []string{"name", "description", "strict", "schema"} {
			if value, ok := format[key]; ok {
				schema[key] = value
			}
		}
		return map[string]any{"type": "json_schema", "json_schema": schema}
	default:
		return nil
	}
}

func chatResponseFormatToResponses(value any) map[string]any {
	format, _ := value.(map[string]any)
	switch anyString(format["type"]) {
	case "json_object", "text":
		return map[string]any{"type": format["type"]}
	case "json_schema":
		schema, _ := format["json_schema"].(map[string]any)
		result := map[string]any{"type": "json_schema"}
		for _, key := range []string{"name", "description", "strict", "schema"} {
			if value, ok := schema[key]; ok {
				result[key] = value
			}
		}
		return result
	default:
		return nil
	}
}

func chatImageDetail(value any) string {
	switch strings.ToLower(strings.TrimSpace(anyString(value))) {
	case "original":
		return "high"
	case "auto", "low", "high":
		return strings.ToLower(strings.TrimSpace(anyString(value)))
	default:
		return ""
	}
}

func incompleteDetails(reason string) (map[string]any, bool) {
	switch strings.TrimSpace(reason) {
	case "length", "max_tokens":
		return map[string]any{"reason": "max_output_tokens"}, true
	case "content_filter":
		return map[string]any{"reason": "content_filter"}, true
	default:
		return nil, false
	}
}

func customToolRefsFromResponses(payload []byte) []loweredToolRef {
	var source map[string]any
	if json.Unmarshal(payload, &source) != nil {
		return nil
	}
	refs := make([]loweredToolRef, 0)
	var visit func(any, string)
	visit = func(value any, namespace string) {
		for _, raw := range asAnySlice(value) {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			kind := anyString(tool["type"])
			if kind == "namespace" {
				visit(tool["tools"], anyString(tool["name"]))
				continue
			}
			name := qualifyToolName(namespace, anyString(tool["name"]))
			if kind == "custom" && name != "" {
				refs = append(refs, loweredToolRef{Name: name, Namespace: namespace, Custom: true})
			}
		}
	}
	visit(source["tools"], "")
	for _, raw := range asAnySlice(source["input"]) {
		if item, ok := raw.(map[string]any); ok && item["type"] == "additional_tools" {
			visit(item["tools"], "")
		}
	}
	return refs
}
