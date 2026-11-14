package upstream

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func BenchmarkPrepareCodexWebsiteRequest(b *testing.B) {
	message := `{"role":"user","content":[{"type":"input_text","text":"` + strings.Repeat("x", 512) + `"}]}`
	for _, normalized := range []bool{false, true} {
		name, fields := "adapt", `,"store":true,"max_output_tokens":100`
		if normalized {
			name, fields = "normalized", `,"store":false,"stream":true`
		}
		b.Run(name, func(b *testing.B) {
			payload := []byte(`{"model":"gpt-test","input":[` + strings.TrimSuffix(strings.Repeat(message+",", 512), ",") + `]` + fields + `}`)
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			for b.Loop() {
				if _, err := prepareCodexWebsiteRequest(payload); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestCodexWebsiteAdaptationPreservesOpaqueJSONAndCallerBody(t *testing.T) {
	for _, fields := range []string{`,"store":false,"stream":true`, `,"store":true,"max_output_tokens":123`} {
		body := []byte(`{"model":"test","input":[],"opaque":{"integer":9007199254740993,"decimal":1.2300,"seal":"a\\b\"c"}` + fields + `}`)
		original := bytes.Clone(body)
		adapted, err := prepareCodexWebsiteRequest(body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, original) {
			t.Fatal("adaptation mutated the caller's request/log buffer")
		}
		if gjson.GetBytes(adapted.Body, "opaque").Raw != gjson.GetBytes(original, "opaque").Raw {
			t.Fatalf("opaque JSON was re-encoded: %s", adapted.Body)
		}
	}
}

func TestCodexWebsiteAdaptationRejectsNonObject(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `"hello"`, `42`} {
		if _, err := prepareCodexWebsiteRequest([]byte(body)); err == nil {
			t.Fatalf("accepted non-object: %s", body)
		}
	}
}

func TestModelRewritePreservesOpaqueJSONAndCallerBody(t *testing.T) {
	body := []byte(`{"model":"public","input":[],"opaque":{"integer":9007199254740993,"decimal":1.2300}}`)
	original := bytes.Clone(body)
	got := rewriteJSONModel(body, "upstream")
	if !bytes.Equal(body, original) || gjson.GetBytes(got, "model").Str != "upstream" || gjson.GetBytes(got, "opaque").Raw != gjson.GetBytes(original, "opaque").Raw {
		t.Fatalf("model rewrite changed unrelated JSON or caller buffer: %s", got)
	}
}

func TestPrepareCodexWebsiteRequestWrapsStringInputAndDropsLimits(t *testing.T) {
	t.Parallel()
	adapted, err := prepareCodexWebsiteRequest([]byte(`{
		"model":"gpt-5.4",
		"input":"Reply with the single word pong.",
		"max_output_tokens":16,
		"max_tokens":8
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if !adapted.CollectStream {
		t.Fatal("missing stream should collect upstream SSE")
	}
	var body map[string]any
	if err := json.Unmarshal(adapted.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["store"] != false || body["stream"] != true {
		t.Fatalf("store/stream = %#v", body)
	}
	if _, ok := body["max_output_tokens"]; ok {
		t.Fatalf("max_output_tokens leaked: %#v", body)
	}
	if _, ok := body["max_tokens"]; ok {
		t.Fatalf("max_tokens leaked: %#v", body)
	}
	input := asAnySlice(body["input"])
	if len(input) != 1 {
		t.Fatalf("input = %#v", body["input"])
	}
	item, _ := input[0].(map[string]any)
	if item["role"] != "user" {
		t.Fatalf("input item = %#v", item)
	}
	content := asAnySlice(item["content"])
	part, _ := content[0].(map[string]any)
	if part["type"] != "input_text" || part["text"] != "Reply with the single word pong." {
		t.Fatalf("content = %#v", content)
	}
}

func TestPrepareCodexWebsiteRequestKeepsListInputAndClientStream(t *testing.T) {
	t.Parallel()
	adapted, err := prepareCodexWebsiteRequest([]byte(`{
		"model":"gpt-5.4",
		"store":true,
		"stream":true,
		"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if adapted.CollectStream {
		t.Fatal("client stream should pass SSE through")
	}
	var body map[string]any
	if err := json.Unmarshal(adapted.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["store"] != false {
		t.Fatalf("store = %#v", body["store"])
	}
	input := asAnySlice(body["input"])
	if len(input) != 1 {
		t.Fatalf("input rewritten: %#v", body["input"])
	}
}

func TestPrepareCodexWebsiteRequestRejectsNonJSON(t *testing.T) {
	t.Parallel()
	if _, err := prepareCodexWebsiteRequest([]byte("not-json")); err == nil {
		t.Fatal("accepted invalid JSON")
	}
}

func TestCollectResponsesSSEReadsCompletedEvent(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader(strings.Join([]string{
		"event: response.created",
		`data: {"type":"response.created","response":{"id":"resp_1","output":[]}}`,
		"",
		"event: response.completed",
		`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}}`,
		"",
	}, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response["id"] != "resp_1" || response["status"] != "completed" {
		t.Fatalf("response = %#v", response)
	}
}

func TestCollectResponsesSSEAcceptsJSONFallback(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader(`{"id":"resp_1","object":"response","output":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(payload, []byte(`"id":"resp_1"`)) {
		t.Fatalf("payload = %s", payload)
	}
}

func TestCollectResponsesSSEReportsStreamError(t *testing.T) {
	t.Parallel()
	payload, err := collectResponsesSSE(strings.NewReader("data: {\"detail\":\"Store must be set to false\"}\n\n"))
	if err == nil {
		t.Fatal("missing error")
	}
	if !bytes.Contains(payload, []byte("Store must be set to false")) {
		t.Fatalf("payload = %s", payload)
	}
}
