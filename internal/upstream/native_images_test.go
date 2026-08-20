package upstream

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexImagesGenerationsHitImagesPath(t *testing.T) {
	var seen struct {
		path, beta, contentType, body string
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(r.Body)
		seen.path, seen.beta, seen.contentType, seen.body = r.URL.Path, r.Header.Get("OpenAI-Beta"), r.Header.Get("Content-Type"), string(payload)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": 1, "data": []any{map[string]any{"b64_json": "aaaa"}},
			"usage": map[string]any{"input_tokens": 8, "output_tokens": 20, "output_tokens_details": map[string]any{"image_tokens": 20}},
		})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "account_id": "acct", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/images/generations", `{"model":"openai/gpt-image-2","prompt":"a cat","n":1}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	if seen.path != "/images/generations" {
		t.Fatalf("upstream path = %q", seen.path)
	}
	if seen.beta != "" {
		t.Fatalf("OpenAI-Beta = %q", seen.beta)
	}
	if !strings.Contains(seen.body, `"model":"gpt-image-2"`) || !strings.Contains(seen.body, `"prompt":"a cat"`) {
		t.Fatalf("body = %s", seen.body)
	}
	if !strings.Contains(response.Body.String(), `"b64_json":"aaaa"`) {
		t.Fatalf("response = %s", response.Body.String())
	}
}

func TestCodexImagesRejectUnsupportedModel(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("unsupported model should not reach upstream")
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/images/generations", `{"model":"gpt-5.4","prompt":"no"}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "gpt-image-1.5") {
		t.Fatalf("status/body = %d %s", response.Code, response.Body.String())
	}
}

func TestCodexImagesDefaultModelAndImplicitRoute(t *testing.T) {
	var path string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "gpt-image-2" {
			t.Errorf("model = %#v", body["model"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 1, "data": []any{}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/openai/v1/images/generations", `{"prompt":"default"}`)
	if response.Code != http.StatusOK || path != "/images/generations" {
		t.Fatalf("status/path = %d %s %q", response.Code, response.Body.String(), path)
	}
}

func TestCodexImageEditsRewriteMultipartToJSON(t *testing.T) {
	var seen struct{ path, contentType, body string }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(r.Body)
		seen.path, seen.contentType, seen.body = r.URL.Path, r.Header.Get("Content-Type"), string(payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 1, "data": []any{}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	body, contentType := imageEditMultipart(t, "gpt-image-1.5", "make it night", []byte("png-bytes"))
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if seen.path != "/images/edits" || !strings.HasPrefix(seen.contentType, "application/json") {
		t.Fatalf("path/type = %q %q", seen.path, seen.contentType)
	}
	if !strings.Contains(seen.body, `"model":"gpt-image-1.5"`) || !strings.Contains(seen.body, `"prompt":"make it night"`) ||
		!strings.Contains(seen.body, `"image_url":"data:image/png;base64,`) {
		t.Fatalf("body = %s", seen.body)
	}
}

func TestXAIImagesMapOpenAISize(t *testing.T) {
	var body map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 1, "data": []any{map[string]any{"url": "https://img.test/1.png"}}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "xai", Provider: "xai", Enabled: true, Models: []string{"grok-4.5"},
		Document: testJSON(t, map[string]any{"type": "xai", "api_key": "key", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/images/generations",
		`{"model":"xai/grok-imagine-image-2.0","prompt":"skyline","size":"1792x1024","quality":"high","n":2,"response_format":"b64_json"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	if body["model"] != "grok-imagine-image-2.0" || body["aspect_ratio"] != "16:9" || body["resolution"] != "1k" ||
		body["quality"] != "medium" || body["n"] != float64(2) || body["response_format"] != "b64_json" {
		t.Fatalf("adapted = %#v", body)
	}
	if _, exists := body["size"]; exists {
		t.Fatalf("size leaked: %#v", body)
	}
}

func TestXAIImageEditsUseImageURL(t *testing.T) {
	var body map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/edits" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 1, "data": []any{}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "xai", Provider: "xai", Enabled: true, Models: []string{"grok-4.5"},
		Document: testJSON(t, map[string]any{"type": "xai", "api_key": "key", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/images/edits",
		`{"model":"grok-imagine-image","prompt":"sketch","image":"https://img.test/src.png"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	image, _ := body["image"].(map[string]any)
	if image["type"] != "image_url" || image["url"] != "https://img.test/src.png" {
		t.Fatalf("image = %#v", body["image"])
	}
}

func TestOpenAICompatImagesPassthroughMultipart(t *testing.T) {
	var seen struct{ path, contentType string }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.path, seen.contentType = r.URL.Path, r.Header.Get("Content-Type")
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 1, "data": []any{}})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "openai", Provider: "openai", Enabled: true, Models: []string{"gpt-image-2"},
		Document: testJSON(t, map[string]any{"type": "openai", "api_key": "key", "base_url": provider.URL}),
	})
	body, contentType := imageEditMultipart(t, "gpt-image-2", "edit", []byte("png"))
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	runtime.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if seen.path != "/images/edits" || !strings.HasPrefix(seen.contentType, "multipart/form-data") {
		t.Fatalf("path/type = %q %q", seen.path, seen.contentType)
	}
}

func TestCodexChatStillRewritesToResponses(t *testing.T) {
	var path string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "resp_1", "model": "gpt-5.4", "created_at": 1, "status": "completed",
			"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "ok"}}}},
		})
	}))
	defer provider.Close()
	runtime := newTestRuntime(t, Credential{
		ID: "codex", Provider: "codex", Enabled: true, Models: []string{"gpt-5.4"},
		Document: testJSON(t, map[string]any{"type": "codex", "access_token": "token", "base_url": provider.URL}),
	})
	response := runtimeRequest(t, runtime, http.MethodPost, "/v1/chat/completions", `{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}]}`)
	if response.Code != http.StatusOK || path != "/responses" {
		t.Fatalf("status/path = %d %q %s", response.Code, path, response.Body.String())
	}
}

func imageEditMultipart(t *testing.T, model, prompt string, image []byte) ([]byte, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writer.WriteField("model", model); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", prompt); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("image", "source.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(image); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), writer.FormDataContentType()
}
