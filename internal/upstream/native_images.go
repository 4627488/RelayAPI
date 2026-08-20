package upstream

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	defaultImagesModel     = "gpt-image-2"
	imageMultipartMemory   = 32 << 20
	gptImage15Model        = "gpt-image-1.5"
	gptImage2Model         = "gpt-image-2"
	xaiImagineModel        = "grok-imagine-image"
	xaiImagineQualityModel = "grok-imagine-image-quality"
	xaiImagine20Model      = "grok-imagine-image-2.0"
)

func isImagesPath(path string) bool {
	return path == "/images/generations" || path == "/images/edits"
}

func implicitProviderImageModels(provider string) []string {
	switch provider {
	case "codex":
		return []string{gptImage15Model, gptImage2Model}
	case "xai":
		return []string{xaiImagineModel, xaiImagineQualityModel, xaiImagine20Model}
	default:
		return nil
	}
}

func imageModelBase(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndex(model, "/"); index >= 0 && index < len(model)-1 {
		model = strings.TrimSpace(model[index+1:])
	}
	return model
}

func isDirectCodexImageModel(model string) bool {
	switch imageModelBase(model) {
	case gptImage15Model, gptImage2Model:
		return true
	default:
		return false
	}
}

func isXAIImagineModel(model string) bool {
	switch imageModelBase(model) {
	case xaiImagineModel, xaiImagineQualityModel, xaiImagine20Model:
		return true
	default:
		return false
	}
}

func canonicalImageModel(model string) string {
	base := imageModelBase(model)
	if isDirectCodexImageModel(base) || isXAIImagineModel(base) {
		return base
	}
	return strings.TrimSpace(model)
}

func requestInferenceModel(body []byte, contentType string) string {
	if model := jsonString(body, "model"); model != "" {
		return model
	}
	return formRequestField(body, contentType, "model")
}

func formRequestField(body []byte, contentType, name string) string {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	switch mediaType {
	case "application/x-www-form-urlencoded":
		values, parseErr := url.ParseQuery(string(body))
		if parseErr != nil {
			return ""
		}
		return strings.TrimSpace(values.Get(name))
	case "multipart/form-data":
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return ""
		}
		reader := multipart.NewReader(bytes.NewReader(body), boundary)
		for {
			part, partErr := reader.NextPart()
			if partErr != nil {
				return ""
			}
			if part.FileName() != "" || part.FormName() != name {
				_ = part.Close()
				continue
			}
			value, _ := io.ReadAll(io.LimitReader(part, 4<<10))
			_ = part.Close()
			return strings.TrimSpace(string(value))
		}
	default:
		return ""
	}
}

func prepareImagesProviderRequest(request *http.Request, credential *nativeCredential, path string, body []byte, model string) ([]byte, error) {
	switch credential.Provider {
	case "codex":
		if !isDirectCodexImageModel(model) {
			return nil, fmt.Errorf("Codex 生图仅支持 gpt-image-1.5 或 gpt-image-2")
		}
	case "xai":
		if !isXAIImagineModel(model) {
			return nil, fmt.Errorf("xAI 生图仅支持 grok-imagine-image、grok-imagine-image-quality 或 grok-imagine-image-2.0")
		}
	}
	adapted, contentType, err := prepareImagesRequest(body, request.Header.Get("Content-Type"), path, credential.Provider, model)
	if err != nil {
		return nil, err
	}
	if (credential.Provider == "codex" || credential.Provider == "xai") && strings.TrimSpace(jsonString(adapted, "prompt")) == "" {
		return nil, fmt.Errorf("缺少 prompt")
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return adapted, nil
}

func prepareImagesRequest(body []byte, contentType, path, provider, model string) ([]byte, string, error) {
	switch provider {
	case "xai":
		normalized, err := normalizeImagesJSON(body, contentType, model)
		if err != nil {
			return nil, "", err
		}
		adapted, adaptErr := adaptXAIImagesRequest(normalized, path, model)
		return adapted, "application/json", adaptErr
	case "codex":
		if isMultipart(contentType) {
			encoded, err := multipartImagesToJSON(body, contentType, model)
			return encoded, "application/json", err
		}
		return rewriteJSONModel(body, model), firstNonEmpty(contentType, "application/json"), nil
	default:
		if model != "" && json.Valid(body) {
			return rewriteJSONModel(body, model), contentType, nil
		}
		return body, contentType, nil
	}
}

func isMultipart(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && strings.HasPrefix(strings.ToLower(mediaType), "multipart/")
}

func normalizeImagesJSON(body []byte, contentType, model string) ([]byte, error) {
	if !isMultipart(contentType) {
		if model == "" {
			return body, nil
		}
		return rewriteJSONModel(body, model), nil
	}
	return multipartImagesToJSON(body, contentType, model)
}

func multipartImagesToJSON(body []byte, contentType, model string) ([]byte, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, fmt.Errorf("invalid multipart image request: %w", err)
	}
	boundary := strings.TrimSpace(params["boundary"])
	if boundary == "" {
		return nil, fmt.Errorf("multipart boundary is missing")
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	form, err := reader.ReadForm(imageMultipartMemory)
	if err != nil {
		return nil, fmt.Errorf("read multipart image request: %w", err)
	}
	defer func() { _ = form.RemoveAll() }()

	root := map[string]any{}
	if model != "" {
		root["model"] = model
	}
	for key, values := range form.Value {
		key = strings.TrimSpace(key)
		if key == "" || key == "model" || len(values) == 0 {
			continue
		}
		if len(values) == 1 {
			root[key] = imageFormScalar(key, values[0])
			continue
		}
		items := make([]any, 0, len(values))
		for _, value := range values {
			items = append(items, imageFormScalar(key, value))
		}
		root[key] = items
	}
	images := make([]any, 0)
	for _, headers := range imageMultipartFiles(form) {
		dataURL, fileErr := multipartFileDataURL(headers)
		if fileErr != nil {
			return nil, fileErr
		}
		images = append(images, map[string]any{"image_url": dataURL})
	}
	if len(images) > 0 {
		root["images"] = images
	}
	if files := form.File["mask"]; len(files) > 0 {
		dataURL, fileErr := multipartFileDataURL(files[0])
		if fileErr != nil {
			return nil, fileErr
		}
		root["mask"] = map[string]any{"image_url": dataURL}
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func imageFormScalar(key, value string) any {
	value = strings.TrimSpace(value)
	switch key {
	case "n", "output_compression", "partial_images":
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return parsed
		}
	case "stream":
		if parsed, err := strconv.ParseBool(value); err == nil {
			return parsed
		}
	}
	return value
}

func imageMultipartFiles(form *multipart.Form) []*multipart.FileHeader {
	files := make([]*multipart.FileHeader, 0)
	for _, name := range []string{"image", "image[]", "images"} {
		files = append(files, form.File[name]...)
	}
	return files
}

func multipartFileDataURL(header *multipart.FileHeader) (string, error) {
	if header == nil {
		return "", fmt.Errorf("image file is missing")
	}
	file, err := header.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()
	payload, err := io.ReadAll(io.LimitReader(file, imageMultipartMemory))
	if err != nil {
		return "", err
	}
	mediaType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if mediaType == "" || mediaType == "application/octet-stream" {
		if detected := mime.TypeByExtension(extensionOf(header.Filename)); detected != "" {
			mediaType = detected
		}
	}
	if mediaType == "" || mediaType == "application/octet-stream" {
		mediaType = "image/png"
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(payload), nil
}

func extensionOf(name string) string {
	index := strings.LastIndex(name, ".")
	if index < 0 {
		return ""
	}
	return name[index:]
}

func adaptXAIImagesRequest(body []byte, path, model string) ([]byte, error) {
	var source map[string]any
	if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &source) != nil {
		return nil, fmt.Errorf("invalid image request JSON")
	}
	if source == nil {
		source = map[string]any{}
	}
	prompt := strings.TrimSpace(anyString(source["prompt"]))
	if prompt == "" {
		return nil, fmt.Errorf("缺少 prompt")
	}
	target := map[string]any{
		"model":  canonicalXAIImagineModel(model),
		"prompt": prompt,
	}
	if format := xaiImagesResponseFormat(anyString(source["response_format"])); format != "" {
		target["response_format"] = format
	}
	aspect := xaiImagesAspectRatio(anyString(source["aspect_ratio"]))
	if aspect == "" {
		aspect = xaiImagesAspectRatioFromSize(anyString(source["size"]))
	}
	if aspect == "" {
		aspect = "1:1"
	}
	target["aspect_ratio"] = aspect
	resolution := xaiImagesResolution(anyString(source["resolution"]), anyString(source["size"]))
	if resolution != "" {
		target["resolution"] = resolution
	}
	if quality := xaiImagesQuality(anyString(source["quality"])); quality != "" {
		target["quality"] = quality
	}
	if count, ok := intImageCount(source["n"]); ok {
		target["n"] = count
	}
	if path == "/images/edits" {
		images := collectImageURLs(source)
		if len(images) == 0 {
			return nil, fmt.Errorf("缺少要编辑的图片")
		}
		target["image"] = map[string]any{"type": "image_url", "url": images[0]}
		if len(images) > 1 {
			refs := make([]any, 0, len(images))
			for _, url := range images {
				refs = append(refs, map[string]any{"type": "image_url", "url": url})
			}
			target["images"] = refs
		}
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func canonicalXAIImagineModel(model string) string {
	switch imageModelBase(model) {
	case xaiImagineQualityModel:
		return xaiImagineQualityModel
	case xaiImagine20Model:
		return xaiImagine20Model
	default:
		return xaiImagineModel
	}
}

func xaiImagesResponseFormat(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "url") {
		return "url"
	}
	if strings.EqualFold(strings.TrimSpace(value), "b64_json") {
		return "b64_json"
	}
	return ""
}

func xaiImagesAspectRatio(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1:1", "square":
		return "1:1"
	case "16:9", "landscape":
		return "16:9"
	case "9:16", "portrait":
		return "9:16"
	case "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return ""
	}
}

func xaiImagesAspectRatioFromSize(size string) string {
	switch strings.ToLower(strings.TrimSpace(size)) {
	case "1024x1024", "2048x2048", "1:1":
		return "1:1"
	case "1792x1024", "16:9":
		return "16:9"
	case "1024x1792", "9:16":
		return "9:16"
	case "1536x1024", "3:2":
		return "3:2"
	case "1024x1536", "2:3":
		return "2:3"
	default:
		return ""
	}
}

func xaiImagesResolution(raw, size string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1k", "2k":
		return strings.ToLower(strings.TrimSpace(raw))
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(size)), "2048") {
		return "2k"
	}
	if strings.TrimSpace(size) != "" {
		return "1k"
	}
	return ""
}

func xaiImagesQuality(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low":
		return "low"
	case "medium", "high", "auto":
		return "medium"
	default:
		return ""
	}
}

func intImageCount(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed > 0 {
			return int64(typed), true
		}
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil && parsed > 0
	case int:
		return int64(typed), typed > 0
	case int64:
		return typed, typed > 0
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed, err == nil && parsed > 0
	}
	return 0, false
}

func collectImageURLs(source map[string]any) []string {
	urls := make([]string, 0)
	appendURL := func(value any) {
		switch typed := value.(type) {
		case string:
			if text := strings.TrimSpace(typed); text != "" {
				urls = append(urls, text)
			}
		case map[string]any:
			if text := firstNonEmpty(anyString(typed["image_url"]), anyString(typed["url"])); text != "" {
				urls = append(urls, text)
			}
		}
	}
	appendURL(source["image"])
	for _, raw := range asAnySlice(source["images"]) {
		appendURL(raw)
	}
	return urls
}

func appendUniqueRoute(ids []string, id string) []string {
	for _, existing := range ids {
		if existing == id {
			return ids
		}
	}
	return append(ids, id)
}
