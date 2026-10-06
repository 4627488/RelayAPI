package app

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestReadRequestMeta(t *testing.T) {
	tests := []struct {
		body, path, model, effort string
		stream                    bool
		imageCount                int
	}{
		{`{"model":"gpt-5.4","stream":true}`, "/v1/responses", "gpt-5.4", "", true, 0},
		{`{"model":"gpt-image","n":3,"reasoning":{"effort":"high"}}`, "/v1/responses", "gpt-image", "high", false, 3},
	}
	for _, test := range tests {
		got := readRequestMeta([]byte(test.body), test.path)
		if got.Model != test.model || got.ReasoningEffort != test.effort || got.Stream != test.stream || got.ImageCount != test.imageCount {
			t.Errorf("metadata = %+v, want model %q, effort %q, stream %t, images %d", got, test.model, test.effort, test.stream, test.imageCount)
		}
	}
}

func BenchmarkReadRequestMetaLongPrompt(b *testing.B) {
	body := []byte(`{"model":"gpt-5.6","stream":true,"reasoning":{"effort":"high"},"input":"` + strings.Repeat("x", 1<<20) + `"}`)
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for range b.N {
		_ = readRequestMeta(body, "/v1/responses")
	}
}

func TestRequestMetadataReadsWebSocketQueryModel(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "http://relay.test/v1/realtime?model=gpt-realtime", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	meta := requestMetadata(nil, request)
	if meta.Model != "gpt-realtime" || !meta.Stream {
		t.Fatalf("metadata = %+v", meta)
	}
}

func TestGeminiModelPathControlsAdmissionAndAlias(t *testing.T) {
	for _, action := range []string{"generateContent", "streamGenerateContent", "countTokens"} {
		request := httptest.NewRequest(http.MethodPost, "/v1beta/models/fast:"+action+"?alt=sse", nil)
		body := []byte(`{"model":"decoy","contents":[{"parts":[{"text":"hi"}]}]}`)
		meta := requestMetadata(body, request)
		if meta.Model != "fast" || meta.Stream != (action == "streamGenerateContent") {
			t.Fatalf("path must control Gemini admission: %+v", meta)
		}
		resolved := resolveAPIKeyModel(meta.Model, []store.APIKeyModelAlias{{Alias: "fast", Model: "gemini-2.5-flash"}})
		rewritten, err := rewriteRequestModel(body, request.URL, meta.Model, resolved.Model)
		if err != nil || request.URL.Path != "/v1beta/models/gemini-2.5-flash:"+action || request.URL.Query().Get("alt") != "sse" || string(rewritten) != string(body) {
			t.Fatalf("Gemini alias changed payload or action: %s %s %v", request.URL, rewritten, err)
		}
	}
}

func TestRequestMetadataReadsMultipartImageModel(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", "gpt-image-1"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("n", "3"); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreateFormFile("image", "input.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("not-a-real-png"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(body.Bytes()))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	meta := requestMetadata(body.Bytes(), request)
	if meta.Model != "gpt-image-1" || meta.ImageCount != 3 {
		t.Fatalf("metadata = %+v", meta)
	}
}

func TestResolveAPIKeyModelIsCaseInsensitive(t *testing.T) {
	meta := resolveAPIKeyModel("FAST", []store.APIKeyModelAlias{{Alias: "fast", Model: "gemini-2.5-flash"}})
	if meta.RequestedModel != "FAST" || meta.Model != "gemini-2.5-flash" || meta.ModelAlias != "FAST" {
		t.Fatalf("resolved model = %+v", meta)
	}
	passthrough := resolveAPIKeyModel("gpt-5.6", nil)
	if passthrough.Model != "gpt-5.6" || passthrough.RequestedModel != "gpt-5.6" || passthrough.ModelAlias != "" {
		t.Fatalf("passthrough model = %+v", passthrough)
	}
}

func TestRewriteRequestModelCoversBodyPathAndQuery(t *testing.T) {
	t.Run("json body preserves other raw values", func(t *testing.T) {
		request, _ := http.NewRequest(http.MethodPost, "http://relay.test/v1/responses", nil)
		body, err := rewriteRequestModel([]byte("{ \n  \"model\": \"fast\", \"large\":9007199254740993}"), request.URL, "fast", "gpt-5.6")
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "{ \n  \"model\": \"gpt-5.6\", \"large\":9007199254740993}" {
			t.Fatalf("rewrite changed unrelated JSON bytes: %s", body)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(body, &object); err != nil {
			t.Fatal(err)
		}
		if string(object["model"]) != `"gpt-5.6"` || string(object["large"]) != "9007199254740993" {
			t.Fatalf("rewritten body = %s", body)
		}
	})
	t.Run("query", func(t *testing.T) {
		request, _ := http.NewRequest(http.MethodGet, "http://relay.test/v1/realtime?model=fast&voice=alloy", nil)
		if _, err := rewriteRequestModel(nil, request.URL, "fast", "gpt-realtime"); err != nil {
			t.Fatal(err)
		}
		if request.URL.Query().Get("model") != "gpt-realtime" || request.URL.Query().Get("voice") != "alloy" {
			t.Fatalf("rewritten query = %q", request.URL.RawQuery)
		}
	})
}

func TestMultipartModelAliasPreservesImageContents(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("model", "image-alias")
	file, _ := writer.CreateFormFile("image", "input.png")
	image := []byte{0, 1, 255, '\r', '\n', 128}
	_, _ = file.Write(image)
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", nil)
	forwarded, err := rewriteRequestModel(body.Bytes(), request.URL, "image-alias", "gpt-image-2", writer.FormDataContentType())
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(bytes.NewReader(forwarded), writer.Boundary())
	model, _ := reader.NextPart()
	value, _ := io.ReadAll(model)
	if string(value) != "gpt-image-2" {
		t.Fatalf("model alias not rewritten: %s", value)
	}
	part, _ := reader.NextPart()
	value, _ = io.ReadAll(part)
	if part.FileName() != "input.png" || !bytes.Equal(value, image) {
		t.Fatal("model rewrite corrupted the input image")
	}
}

func TestReadBoundedRequestBody(t *testing.T) {
	t.Run("known content length", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("payload"))
		body, err := readBoundedRequestBody(httptest.NewRecorder(), request, 16)
		if err != nil || string(body) != "payload" {
			t.Fatalf("body = %q, err = %v", body, err)
		}
	})
	t.Run("too large", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("payload"))
		body, err := readBoundedRequestBody(httptest.NewRecorder(), request, 4)
		if err == nil || len(body) > 4 {
			t.Fatalf("body bytes = %d, err = %v", len(body), err)
		}
	})
}
