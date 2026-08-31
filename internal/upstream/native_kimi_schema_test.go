package upstream

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPrepareKimiCPABodySanitizesPinnedKimiCredential(t *testing.T) {
	input := []byte(`{
		"model":"kimi-k3",
		"tools":[{
			"type":"function",
			"function":{
				"name":"search",
				"parameters":{
					"type":"object",
					"$defs":{"__schema20":{"type":"object","$ref":"#/$defs/Item"},"Item":{"properties":{"name":{"type":"string"}}}}
				}
			}
		}]
	}`)
	rewritten := PrepareKimiCPABody("kimi-d2f83569e3dd08d9", input)
	var root map[string]any
	if err := json.Unmarshal(rewritten, &root); err != nil {
		t.Fatal(err)
	}
	wrapper := toolParameters(t, root)["$defs"].(map[string]any)["__schema20"].(map[string]any)
	if _, hasType := wrapper["type"]; hasType {
		t.Fatalf("CPA hop still has type beside $ref: %#v", wrapper)
	}
}

func TestPrepareKimiCPABodyLeavesNonKimiRequests(t *testing.T) {
	input := []byte(`{"model":"gpt-5.4","tools":[{"type":"function","function":{"name":"search","parameters":{"type":"object","$defs":{"__schema20":{"type":"object","$ref":"#/$defs/Item"}}}}}]}`)
	if got := PrepareKimiCPABody("codex-56a34c57", input); string(got) != string(input) {
		t.Fatalf("non-Kimi body was rewritten: %s", got)
	}
}

func TestSanitizeKimiToolSchemasMovesTypeOffRefParent(t *testing.T) {
	input := []byte(`{
		"model":"kimi-k3",
		"tools":[{
			"type":"function",
			"function":{
				"name":"search",
				"parameters":{
					"type":"object",
					"properties":{"item":{"$ref":"#/$defs/__schema20"}},
					"$defs":{
						"__schema20":{"type":"object","$ref":"#/$defs/Item"},
						"Item":{"properties":{"name":{"type":"string"}}}
					}
				}
			}
		}]
	}`)
	rewritten := sanitizeKimiToolSchemas(input)
	var root map[string]any
	if err := json.Unmarshal(rewritten, &root); err != nil {
		t.Fatal(err)
	}
	defs := toolParameters(t, root)["$defs"].(map[string]any)
	wrapper := defs["__schema20"].(map[string]any)
	item := defs["Item"].(map[string]any)
	if _, hasType := wrapper["type"]; hasType {
		t.Fatalf("parent still has type: %#v", wrapper)
	}
	if wrapper["$ref"] != "#/$defs/Item" {
		t.Fatalf("$ref = %#v", wrapper["$ref"])
	}
	if item["type"] != "object" {
		t.Fatalf("referenced schema type = %#v", item["type"])
	}
}

func TestSanitizeKimiToolSchemasMovesTypeIntoAnyOfBranches(t *testing.T) {
	input := []byte(`{
		"tools":[{
			"type":"function",
			"function":{
				"name":"route",
				"parameters":{
					"type":"object",
					"properties":{
						"target":{
							"type":"object",
							"anyOf":[{"required":["route"]},{"required":["file"]}]
						}
					}
				}
			}
		}]
	}`)
	rewritten := sanitizeKimiToolSchemas(input)
	var root map[string]any
	if err := json.Unmarshal(rewritten, &root); err != nil {
		t.Fatal(err)
	}
	target := toolParameters(t, root)["properties"].(map[string]any)["target"].(map[string]any)
	if _, hasType := target["type"]; hasType {
		t.Fatalf("anyOf parent still has type: %#v", target)
	}
	for _, raw := range asAnySlice(target["anyOf"]) {
		branch := raw.(map[string]any)
		if branch["type"] != "object" {
			t.Fatalf("anyOf branch = %#v", branch)
		}
	}
}

func TestSanitizeKimiToolSchemasIsNoopWithoutTools(t *testing.T) {
	input := []byte(`{"model":"kimi-k3","messages":[{"role":"user","content":"hi"}]}`)
	if got := sanitizeKimiToolSchemas(input); string(got) != string(input) {
		t.Fatalf("rewrote a body without tools: %s", got)
	}
}

func TestSanitizeKimiToolSchemasPreservesExactNumbers(t *testing.T) {
	input := []byte(`{
		"tools":[{
			"type":"function",
			"function":{
				"name":"search",
				"parameters":{
					"type":"object",
					"properties":{
						"limit":{"type":"integer","const":9007199254740993},
						"item":{"type":"object","$ref":"#/$defs/__schema20"}
					},
					"$defs":{"__schema20":{"type":"string"}}
				}
			}
		}]
	}`)
	rewritten := sanitizeKimiToolSchemas(input)
	if !json.Valid(rewritten) || !bytes.Contains(rewritten, []byte(`9007199254740993`)) {
		t.Fatalf("lost exact integer: %s", rewritten)
	}
}

func TestKimiChatForwardsSanitizedToolSchema(t *testing.T) {
	observed := make(chan map[string]any, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		observed <- body
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chat_1", "choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "ok"}, "finish_reason": "stop"}},
		})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "kimi", Provider: "kimi", Enabled: true, Models: []string{"kimi-k3"}, Document: testJSON(t, map[string]any{"type": "kimi", "access_token": "token", "base_url": provider.URL})})
	body := `{
		"model":"kimi-k3",
		"messages":[{"role":"user","content":"hi"}],
		"tools":[{
			"type":"function",
			"function":{
				"name":"search",
				"parameters":{
					"type":"object",
					"properties":{"item":{"$ref":"#/$defs/__schema20"}},
					"$defs":{
						"__schema20":{"type":"object","$ref":"#/$defs/Item"},
						"Item":{"type":"object","properties":{"name":{"type":"string"}}}
					}
				}
			}
		}]
	}`
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", body)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	request := <-observed
	defs := toolParameters(t, request)["$defs"].(map[string]any)
	wrapper := defs["__schema20"].(map[string]any)
	if _, hasType := wrapper["type"]; hasType {
		t.Fatalf("upstream still has type beside $ref: %#v", wrapper)
	}
	if wrapper["$ref"] != "#/$defs/Item" {
		t.Fatalf("$ref = %#v", wrapper["$ref"])
	}
}

func TestKimiResponsesSanitizesTranslatedToolSchema(t *testing.T) {
	observed := make(chan map[string]any, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		observed <- body
		_, _ = io.WriteString(w, `{"id":"chat_1","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{ID: "kimi", Provider: "kimi", Enabled: true, Models: []string{"kimi-k3"}, Document: testJSON(t, map[string]any{"type": "kimi", "access_token": "token", "base_url": provider.URL})})
	body := `{
		"model":"kimi-k3",
		"input":"hello",
		"tools":[{
			"type":"function",
			"name":"search",
			"parameters":{
				"type":"object",
				"properties":{"item":{"$ref":"#/$defs/__schema20"}},
				"$defs":{
					"__schema20":{"type":"object","$ref":"#/$defs/Item"},
					"Item":{"type":"object","properties":{"name":{"type":"string"}}}
				}
			}
		}]
	}`
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/responses", body)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	request := <-observed
	defs := toolParameters(t, request)["$defs"].(map[string]any)
	if _, hasType := defs["__schema20"].(map[string]any)["type"]; hasType {
		t.Fatalf("translated upstream still has type beside $ref: %#v", defs["__schema20"])
	}
}

func toolParameters(t *testing.T, root map[string]any) map[string]any {
	t.Helper()
	tools := asAnySlice(root["tools"])
	if len(tools) == 0 {
		t.Fatal("missing tools")
	}
	tool := tools[0].(map[string]any)
	if function, ok := tool["function"].(map[string]any); ok {
		parameters, _ := function["parameters"].(map[string]any)
		return parameters
	}
	parameters, _ := tool["parameters"].(map[string]any)
	return parameters
}
