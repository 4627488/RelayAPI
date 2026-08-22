package upstream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

type toolRestoreWriter struct {
	io.Writer
	restorer *toolResponseRestorer
}

func (w toolRestoreWriter) Write(payload []byte) (int, error) {
	restored := w.restorer.restore(payload)
	if len(restored) == 0 {
		return len(payload), nil
	}
	_, err := w.Writer.Write(restored)
	return len(payload), err
}

func restoreToolStream(w io.Writer, source io.Reader, restorer *toolResponseRestorer) error {
	reader := bufio.NewReader(source)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if restored := restorer.restore(line); len(restored) > 0 {
				if _, writeErr := w.Write(restored); writeErr != nil {
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

type loweredToolRef struct {
	Name      string
	Namespace string
	Custom    bool
}

// lowerCodexTools converts Responses custom tools and namespaces into the
// ordinary JSON-schema functions accepted by OpenAI-compatible providers.
// The returned restorer recreates the Codex freeform event shape.
func lowerCodexTools(payload []byte) ([]byte, *toolResponseRestorer) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return payload, nil
	}
	refs := make([]loweredToolRef, 0)
	changed := false
	var flatten func(any, string) []any
	flatten = func(value any, namespace string) []any {
		items, _ := value.([]any)
		result := make([]any, 0, len(items))
		for _, value := range items {
			tool, ok := value.(map[string]any)
			if !ok {
				result = append(result, value)
				continue
			}
			kind, _ := tool["type"].(string)
			if kind == "namespace" {
				name, _ := tool["name"].(string)
				result = append(result, flatten(tool["tools"], strings.TrimSpace(name))...)
				changed = true
				continue
			}
			name, _ := tool["name"].(string)
			if name == "" {
				if function, ok := tool["function"].(map[string]any); ok {
					name, _ = function["name"].(string)
				}
			}
			if namespace != "" && name != "" {
				tool["name"] = namespace + "__" + name
				name = namespace + "__" + name
				changed = true
			}
			if kind == "custom" {
				tool["type"] = "function"
				if _, exists := tool["parameters"]; !exists {
					tool["parameters"] = map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string"}}, "required": []any{"input"}, "additionalProperties": false}
				}
				delete(tool, "format")
				refs = append(refs, loweredToolRef{Name: name, Namespace: namespace, Custom: true})
				changed = true
			}
			result = append(result, tool)
		}
		return result
	}
	if _, ok := root["tools"].([]any); ok {
		root["tools"] = flatten(root["tools"], "")
	}
	if input, ok := root["input"].([]any); ok {
		for _, value := range input {
			item, _ := value.(map[string]any)
			if item["type"] == "additional_tools" {
				root["tools"] = append(asAnySlice(root["tools"]), flatten(item["tools"], "")...)
				item["type"] = "message"
				item["role"] = "user"
				item["content"] = []any{}
				delete(item, "tools")
				changed = true
			}
		}
	}
	lowerToolChoice(root["tool_choice"])
	if !changed {
		return payload, nil
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload, nil
	}
	return encoded, newToolResponseRestorer(refs)
}

// xAI Responses accepts a fixed tool-type enum. Codex CLI 0.146+ injects
// `tool_search` (and related input items) which xAI rejects with 422
// "unknown variant `tool_search`".
var xaiAllowedToolTypes = map[string]struct{}{
	"function": {}, "web_search": {}, "x_search": {}, "image_generation": {},
	"collections_search": {}, "file_search": {}, "code_execution": {},
	"code_interpreter": {}, "mcp": {}, "shell": {},
}

var xaiDroppedInputTypes = map[string]struct{}{
	"tool_search": {}, "tool_search_call": {}, "tool_search_output": {},
	"additional_tools": {},
}

func sanitizeXAIResponses(payload []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return payload
	}
	changed := false
	if tools, ok := root["tools"].([]any); ok {
		kept := make([]any, 0, len(tools))
		for _, value := range tools {
			tool, ok := value.(map[string]any)
			if !ok {
				kept = append(kept, value)
				continue
			}
			kind, _ := tool["type"].(string)
			if kind != "" {
				if _, allowed := xaiAllowedToolTypes[kind]; !allowed {
					changed = true
					continue
				}
			}
			kept = append(kept, tool)
		}
		root["tools"] = kept
	}
	if input, ok := root["input"].([]any); ok {
		kept := make([]any, 0, len(input))
		for _, value := range input {
			item, ok := value.(map[string]any)
			if !ok {
				kept = append(kept, value)
				continue
			}
			kind, _ := item["type"].(string)
			if _, drop := xaiDroppedInputTypes[kind]; drop {
				changed = true
				continue
			}
			kept = append(kept, item)
		}
		root["input"] = kept
	}
	if !changed {
		return payload
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	return encoded
}

func lowerToolChoice(value any) {
	choice, ok := value.(map[string]any)
	if !ok {
		return
	}
	if choice["type"] == "custom" {
		choice["type"] = "function"
	}
	if tools, ok := choice["tools"].([]any); ok {
		for _, tool := range tools {
			lowerToolChoice(tool)
		}
	}
}

type toolResponseRestorer struct {
	custom map[string]loweredToolRef
	items  map[string]bool
	index  map[string]bool
}

func newToolResponseRestorer(refs []loweredToolRef) *toolResponseRestorer {
	if len(refs) == 0 {
		return nil
	}
	r := &toolResponseRestorer{custom: map[string]loweredToolRef{}, items: map[string]bool{}, index: map[string]bool{}}
	for _, ref := range refs {
		r.custom[ref.Name] = ref
	}
	return r
}

func (r *toolResponseRestorer) restore(payload []byte) []byte {
	if r == nil || len(payload) == 0 {
		return payload
	}
	prefix, data, suffix := splitSSE(payload)
	var root map[string]any
	if json.Unmarshal(data, &root) != nil {
		return payload
	}
	eventType, _ := root["type"].(string)
	if eventType == "response.function_call_arguments.delta" && r.tracked(root) {
		return nil
	}
	if eventType == "response.function_call_arguments.done" && r.tracked(root) {
		root["type"] = "response.custom_tool_call_input.done"
		root["input"] = unwrapStringInput(root["arguments"])
		delete(root, "arguments")
	}
	if item, ok := root["item"].(map[string]any); ok {
		r.restoreItem(item, root)
	}
	r.restoreItems(root["output"])
	if response, ok := root["response"].(map[string]any); ok {
		r.restoreItems(response["output"])
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	if next, _ := root["type"].(string); next != "" && eventType != "" && next != eventType {
		prefix = bytes.Replace(prefix, []byte("event: "+eventType), []byte("event: "+next), 1)
	}
	return append(append(prefix, encoded...), suffix...)
}

func (r *toolResponseRestorer) restoreItems(value any) {
	for _, value := range asAnySlice(value) {
		if item, ok := value.(map[string]any); ok {
			r.restoreItem(item, nil)
		}
	}
}

func (r *toolResponseRestorer) restoreItem(item, event map[string]any) {
	if item["type"] != "function_call" {
		return
	}
	name, _ := item["name"].(string)
	ref, ok := r.custom[name]
	if !ok {
		return
	}
	item["type"] = "custom_tool_call"
	item["name"] = strings.TrimPrefix(name, ref.Namespace+"__")
	if ref.Namespace != "" {
		item["namespace"] = ref.Namespace
	}
	item["input"] = unwrapStringInput(item["arguments"])
	delete(item, "arguments")
	if id, _ := item["id"].(string); id != "" {
		r.items[id] = true
	}
	if event != nil {
		if index, ok := event["output_index"]; ok {
			encoded, _ := json.Marshal(index)
			r.index[string(encoded)] = true
		}
	}
}

func (r *toolResponseRestorer) tracked(event map[string]any) bool {
	if id, _ := event["item_id"].(string); r.items[id] {
		return true
	}
	encoded, _ := json.Marshal(event["output_index"])
	return r.index[string(encoded)]
}

func unwrapStringInput(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	var object map[string]any
	if json.Unmarshal([]byte(text), &object) == nil {
		if input, exists := object["input"]; exists {
			return input
		}
	}
	return text
}

func splitSSE(payload []byte) (prefix, data, suffix []byte) {
	index := bytes.Index(payload, []byte("data:"))
	if index < 0 {
		return nil, payload, nil
	}
	start := index + len("data:")
	for start < len(payload) && (payload[start] == ' ' || payload[start] == '\t') {
		start++
	}
	end := len(payload)
	for end > start && bytes.ContainsRune([]byte("\r\n \t"), rune(payload[end-1])) {
		end--
	}
	return append([]byte(nil), payload[:start]...), payload[start:end], append([]byte(nil), payload[end:]...)
}

func asAnySlice(value any) []any {
	items, _ := value.([]any)
	return items
}
