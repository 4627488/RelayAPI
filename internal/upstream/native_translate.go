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
	messages := make([]any, 0)
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
			switch item["type"] {
			case "message", nil:
				messages = append(messages, map[string]any{"role": firstNonEmpty(anyString(item["role"]), "user"), "content": responsesContentToChat(item["content"])})
			case "function_call":
				messages = append(messages, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": firstNonEmpty(anyString(item["arguments"]), "{}")}}}})
			case "custom_tool_call":
				arguments, _ := json.Marshal(map[string]any{"input": item["input"]})
				messages = append(messages, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": string(arguments)}}}})
			case "function_call_output", "custom_tool_call_output":
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])), "content": stringifyContent(item["output"])})
			}
		}
	}
	target["messages"] = messages
	if limit, ok := source["max_output_tokens"]; ok {
		target["max_tokens"] = limit
	}
	if reasoning, ok := source["reasoning"].(map[string]any); ok {
		if effort := reasoning["effort"]; effort != nil {
			target["reasoning_effort"] = effort
		}
	}
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
			name := anyString(tool["name"])
			if namespace != "" {
				name = namespace + "__" + name
			}
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
	input := make([]any, 0)
	for _, raw := range asAnySlice(source["messages"]) {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := anyString(message["role"])
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
			input = append(input, map[string]any{"type": "function_call_output", "call_id": message["tool_call_id"], "output": stringifyContent(message["content"])})
			continue
		}
		if content, exists := message["content"]; exists && content != nil {
			input = append(input, map[string]any{"type": "message", "role": role, "content": chatContentToResponses(content, role)})
		}
		for _, rawCall := range asAnySlice(message["tool_calls"]) {
			call, _ := rawCall.(map[string]any)
			function, _ := call["function"].(map[string]any)
			input = append(input, map[string]any{"type": "function_call", "call_id": call["id"], "name": function["name"], "arguments": firstNonEmpty(anyString(function["arguments"]), "{}")})
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
	for _, raw := range asAnySlice(source["choices"]) {
		choice, _ := raw.(map[string]any)
		message, _ := choice["message"].(map[string]any)
		if text := stringifyContent(message["content"]); text != "" {
			output = append(output, map[string]any{"id": generatedID("msg"), "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}})
		}
		for _, rawCall := range asAnySlice(message["tool_calls"]) {
			call, _ := rawCall.(map[string]any)
			function, _ := call["function"].(map[string]any)
			output = append(output, map[string]any{"id": generatedID("fc"), "type": "function_call", "status": "completed", "call_id": call["id"], "name": function["name"], "arguments": firstNonEmpty(anyString(function["arguments"]), "{}")})
		}
	}
	response := map[string]any{"id": firstNonEmpty(anyString(source["id"]), generatedID("resp")), "object": "response", "created_at": unixNumber(source["created"]), "status": "completed", "model": firstNonEmpty(anyString(source["model"]), model), "output": output, "parallel_tool_calls": true}
	if usage, ok := source["usage"].(map[string]any); ok {
		response["usage"] = map[string]any{"input_tokens": usage["prompt_tokens"], "output_tokens": usage["completion_tokens"], "total_tokens": usage["total_tokens"]}
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
	toolCalls := make([]any, 0)
	for _, raw := range asAnySlice(source["output"]) {
		item, _ := raw.(map[string]any)
		switch item["type"] {
		case "message":
			for _, content := range asAnySlice(item["content"]) {
				part, _ := content.(map[string]any)
				if part["type"] == "output_text" {
					text.WriteString(rawString(part["text"]))
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{"id": firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": item["arguments"]}})
		case "custom_tool_call":
			arguments, _ := json.Marshal(map[string]any{"input": item["input"]})
			toolCalls = append(toolCalls, map[string]any{"id": firstNonEmpty(anyString(item["call_id"]), anyString(item["id"])), "type": "function", "function": map[string]any{"name": item["name"], "arguments": string(arguments)}})
		}
	}
	message["content"] = text.String()
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	target := map[string]any{"id": source["id"], "object": "chat.completion", "created": unixNumber(source["created_at"]), "model": firstNonEmpty(anyString(source["model"]), model), "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": "stop"}}}
	if usage, ok := source["usage"].(map[string]any); ok {
		target["usage"] = map[string]any{"prompt_tokens": usage["input_tokens"], "completion_tokens": usage["output_tokens"], "total_tokens": usage["total_tokens"]}
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
	if mode == "responses-to-chat" {
		return translateResponsesStreamToChat(w, source, model)
	}
	reader := bufio.NewReader(source)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			translated := translateSSELine(line, mode, model)
			if len(translated) > 0 {
				if _, writeErr := w.Write(translated); writeErr != nil {
					return writeErr
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func translateResponsesStreamToChat(w io.Writer, source io.Reader, fallbackModel string) error {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	responseID, model := generatedID("chatcmpl"), fallbackModel
	toolIndexes := make(map[int]int)
	customInputs := make(map[int]*strings.Builder)
	nextToolIndex := 0
	toolSeen := false
	emit := func(delta map[string]any, finish any, usage any) error {
		chunk := map[string]any{
			"id":      responseID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []any{map[string]any{
				"index":         0,
				"delta":         delta,
				"finish_reason": finish,
			}},
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
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" || item["type"] == "custom_tool_call" {
				outputIndex := intNumber(event["output_index"])
				index := nextToolIndex
				nextToolIndex++
				toolIndexes[outputIndex] = index
				toolSeen = true
				name, id := anyString(item["name"]), firstNonEmpty(anyString(item["call_id"]), anyString(item["id"]))
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
		case "response.completed":
			finish := "stop"
			if toolSeen {
				finish = "tool_calls"
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
	return map[string]any{"prompt_tokens": numberOrZero(usage["input_tokens"]), "completion_tokens": numberOrZero(usage["output_tokens"]), "total_tokens": numberOrZero(usage["total_tokens"])}
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
	created, messageAdded, contentAdded := false, false, false
	textValue := strings.Builder{}
	tools := make(map[int]*chatStreamTool)
	sequence := 0
	var finalOutput []any
	var latestUsage any
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
	complete := func() error {
		if completed || !terminalReady {
			return nil
		}
		completed = true
		return emit(map[string]any{"type": "response.completed", "response": map[string]any{
			"id": responseID, "object": "response", "status": "completed", "model": model,
			"output": finalOutput, "usage": chatUsageToResponses(latestUsage),
		}})
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
		if !created {
			created = true
			if err := emit(map[string]any{"type": "response.created", "response": map[string]any{"id": responseID, "object": "response", "created_at": unixNumber(chunk["created"]), "status": "in_progress", "model": model, "output": []any{}}}); err != nil {
				return err
			}
		}
		finished := false
		for _, raw := range asAnySlice(chunk["choices"]) {
			choice, _ := raw.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if content := rawString(delta["content"]); content != "" {
				if !messageAdded {
					messageAdded = true
					if err := emit(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"id": messageID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}}); err != nil {
						return err
					}
				}
				if !contentAdded {
					contentAdded = true
					if err := emit(map[string]any{"type": "response.content_part.added", "item_id": messageID, "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}}); err != nil {
						return err
					}
				}
				textValue.WriteString(content)
				if err := emit(map[string]any{"type": "response.output_text.delta", "item_id": messageID, "output_index": 0, "content_index": 0, "delta": content}); err != nil {
					return err
				}
			}
			for _, rawCall := range asAnySlice(delta["tool_calls"]) {
				call, _ := rawCall.(map[string]any)
				index := intNumber(call["index"])
				tool := tools[index]
				function, _ := call["function"].(map[string]any)
				if tool == nil {
					id := firstNonEmpty(anyString(call["id"]), generatedID("fc"))
					tool = &chatStreamTool{Index: index, ID: id, CallID: id, Name: anyString(function["name"])}
					tools[index] = tool
					if err := emit(map[string]any{"type": "response.output_item.added", "output_index": index + boolInt(messageAdded), "item": map[string]any{"id": tool.ID, "type": "function_call", "status": "in_progress", "call_id": tool.CallID, "name": tool.Name, "arguments": ""}}); err != nil {
						return err
					}
				}
				if name := anyString(function["name"]); name != "" {
					tool.Name = name
				}
				arguments := rawString(function["arguments"])
				if arguments != "" {
					tool.Arguments += arguments
					if err := emit(map[string]any{"type": "response.function_call_arguments.delta", "item_id": tool.ID, "output_index": index + boolInt(messageAdded), "delta": arguments}); err != nil {
						return err
					}
				}
			}
			finished = choice["finish_reason"] != nil
		}
		if finished && !terminalReady {
			output := make([]any, 0, 1+len(tools))
			if messageAdded {
				if err := emit(map[string]any{"type": "response.output_text.done", "item_id": messageID, "output_index": 0, "content_index": 0, "text": textValue.String()}); err != nil {
					return err
				}
				part := map[string]any{"type": "output_text", "text": textValue.String(), "annotations": []any{}}
				if err := emit(map[string]any{"type": "response.content_part.done", "item_id": messageID, "output_index": 0, "content_index": 0, "part": part}); err != nil {
					return err
				}
				item := map[string]any{"id": messageID, "type": "message", "status": "completed", "role": "assistant", "content": []any{part}}
				if err := emit(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item}); err != nil {
					return err
				}
				output = append(output, item)
			}
			for index := 0; index < len(tools); index++ {
				tool := tools[index]
				if tool == nil {
					continue
				}
				outputIndex := tool.Index + boolInt(messageAdded)
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
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return complete()
}

func chatUsageToResponses(value any) map[string]any {
	usage, _ := value.(map[string]any)
	return map[string]any{"input_tokens": numberOrZero(usage["prompt_tokens"]), "output_tokens": numberOrZero(usage["completion_tokens"]), "total_tokens": numberOrZero(usage["total_tokens"])}
}

func intNumber(value any) int { number, _ := value.(float64); return int(number) }
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

func translateSSELine(line []byte, mode, model string) []byte {
	text := strings.TrimSpace(string(line))
	if !strings.HasPrefix(text, "data:") || strings.TrimSpace(strings.TrimPrefix(text, "data:")) == "[DONE]" {
		return line
	}
	payload := []byte(strings.TrimSpace(strings.TrimPrefix(text, "data:")))
	if mode == "chat-to-responses" {
		var chunk map[string]any
		if json.Unmarshal(payload, &chunk) != nil {
			return line
		}
		var events []map[string]any
		for _, raw := range asAnySlice(chunk["choices"]) {
			choice, _ := raw.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if content := rawString(delta["content"]); content != "" {
				events = append(events, map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": content})
			}
			for _, rawCall := range asAnySlice(delta["tool_calls"]) {
				call, _ := rawCall.(map[string]any)
				function, _ := call["function"].(map[string]any)
				events = append(events, map[string]any{"type": "response.function_call_arguments.delta", "output_index": call["index"], "item_id": call["id"], "delta": function["arguments"]})
			}
			if choice["finish_reason"] != nil {
				events = append(events, map[string]any{"type": "response.completed", "response": map[string]any{"id": chunk["id"], "object": "response", "status": "completed", "model": firstNonEmpty(anyString(chunk["model"]), model), "output": []any{}}})
			}
		}
		return encodeSSEEvents(events)
	}
	var event map[string]any
	if json.Unmarshal(payload, &event) != nil {
		return line
	}
	chunk := map[string]any{"id": generatedID("chatcmpl"), "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{}}
	switch event["type"] {
	case "response.output_text.delta":
		chunk["choices"] = []any{map[string]any{"index": 0, "delta": map[string]any{"content": event["delta"]}, "finish_reason": nil}}
	case "response.function_call_arguments.delta":
		chunk["choices"] = []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": event["output_index"], "id": event["item_id"], "type": "function", "function": map[string]any{"arguments": event["delta"]}}}}, "finish_reason": nil}}
	case "response.completed":
		chunk["choices"] = []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}
	default:
		return nil
	}
	encoded, _ := json.Marshal(chunk)
	return []byte("data: " + string(encoded) + "\n\n")
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
			result = append(result, map[string]any{"type": "image_url", "image_url": map[string]any{"url": part["image_url"], "detail": part["detail"]}})
		}
	}
	return result
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
			result = append(result, map[string]any{"type": "input_image", "image_url": image["url"], "detail": image["detail"]})
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
func encodeSSEEvents(events []map[string]any) []byte {
	var builder strings.Builder
	for _, event := range events {
		encoded, _ := json.Marshal(event)
		builder.WriteString("data: ")
		builder.Write(encoded)
		builder.WriteString("\n\n")
	}
	return []byte(builder.String())
}
