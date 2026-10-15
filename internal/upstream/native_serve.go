package upstream

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/tidwall/gjson"
)

func (r *nativeRuntime) serveHTTP(w http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet && strings.TrimRight(request.URL.Path, "/") == "/v1/models" {
		r.ServeModels(w, request)
		return
	}
	if isRuntimeWebSocket(request) {
		r.serveWebSocket(w, request)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<30))
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", "unable to read request")
		return
	}
	r.Serve(w, request, body)
}

func (r *nativeRuntime) Serve(w http.ResponseWriter, request *http.Request, body []byte) {
	r.serveInference(w, request, body)
}

func (r *nativeRuntime) ServeModels(w http.ResponseWriter, request *http.Request) {
	models := r.Models()
	w.Header().Set("Content-Type", "application/json")
	if _, codex := request.URL.Query()["client_version"]; codex {
		items := make([]map[string]any, 0, len(models))
		for index, model := range models {
			item := NewCodexCatalogItem(model)
			CompleteCodexCatalogItem(item, 100+index*10)
			items = append(items, item)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"models": items})
		return
	}
	items := make([]map[string]any, 0, len(models))
	for _, model := range models {
		provider, _ := r.ModelProvider(model)
		items = append(items, map[string]any{"id": model, "object": "model", "owned_by": provider})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": items})
}

func (r *nativeRuntime) serveInference(w http.ResponseWriter, request *http.Request, body []byte) {
	requestID := strings.TrimSpace(request.Header.Get("X-Relay-Request-ID"))
	trace := r.beginTrace(requestID)
	defer r.finishTrace(requestID)
	requestPath := canonicalInferencePath(request.URL.Path)
	model := requestInferenceModel(body, request.Header.Get("Content-Type"))
	if isImagesPath(requestPath) && model == "" {
		model = defaultImagesModel
	}
	if canonical := canonicalImageModel(model); canonical != "" {
		model = canonical
	}
	pinned := strings.TrimSpace(request.Header.Get("X-Relay-Upstream-Credential-ID"))
	affinityKey := sessionAffinityKey(body, request.Header)
	credential, ok := r.selectCredential(model, pinned, affinityKey)
	if !ok {
		writeRuntimeError(w, http.StatusServiceUnavailable, "model_account_unavailable", "no upstream credential can serve this model")
		return
	}
	r.rememberAffinity(affinityKey, credential)
	upstreamModel := credential.ModelRoutes[strings.ToLower(model)]
	if upstreamModel == "" {
		upstreamModel = model
	}
	body = rewriteJSONModel(body, upstreamModel)
	clientStream := jsonBool(body, "stream")
	collectStream := false
	responseMode := "passthrough"
	var err error
	var toolRestorer *toolResponseRestorer
	if isImagesPath(requestPath) {
		body, err = prepareImagesProviderRequest(request, credential, requestPath, body, upstreamModel)
	} else if credential.Provider == "kimi" && isResponsesPath(requestPath) {
		toolRestorer = newToolResponseRestorer(customToolRefsFromResponses(body))
		body, err = responsesToChatRequest(body)
		requestPath = "/chat/completions"
		responseMode = "chat-to-responses"
	} else if (credential.Provider == "codex" || credential.Provider == "aliyun-bailian") && isChatPath(requestPath) {
		body, err = chatToResponsesRequest(body)
		requestPath = "/responses"
		responseMode = "responses-to-chat"
	}
	if err != nil {
		writeRuntimeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if credential.Provider == "codex" && isResponsesPath(requestPath) {
		adapted, adaptErr := prepareCodexWebsiteRequest(body)
		if adaptErr != nil {
			writeRuntimeError(w, http.StatusBadRequest, "invalid_request", adaptErr.Error())
			return
		}
		body = adapted.Body
		collectStream = adapted.CollectStream
	}
	trace.setSelection(credential, model, responseMode)
	if credential.Provider == "xai" && !isImagesPath(requestPath) {
		body, toolRestorer = lowerCodexTools(body)
	}
	target := credential.upstreamURL(requestPath)
	response, err := r.doProviderRequest(request, credential, target, requestPath, body, trace)
	if err != nil {
		r.mu.RLock()
		threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
		r.mu.RUnlock()
		credential.record(false, err.Error(), true, threshold, cooldown)
		writeRuntimeError(w, http.StatusBadGateway, "upstream_connection_failed", err.Error())
		return
	}
	defer response.Body.Close()
	r.mu.RLock()
	threshold, cooldown := r.settings.FailureThreshold, r.settings.FailureCooldown
	r.mu.RUnlock()
	availabilityFailure := response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden || providerAvailabilityStatus(response.StatusCode)
	if response.StatusCode < 400 {
		credential.record(true, "", false, threshold, cooldown)
	} else if availabilityFailure {
		credential.record(false, http.StatusText(response.StatusCode), true, threshold, cooldown)
	} else {
		credential.releaseProbe()
	}
	if response.StatusCode >= http.StatusBadRequest {
		writeProviderError(w, response)
		return
	}
	var source io.Reader = response.Body
	modelObserver := &responseModelObserver{stream: clientStream || collectStream || strings.Contains(response.Header.Get("Content-Type"), "text/event-stream")}
	source = io.TeeReader(source, modelObserver)
	defer func() {
		if trace != nil {
			trace.UpstreamModel = modelObserver.finish()
		}
	}()
	if collectStream && response.StatusCode < 400 {
		payload, collectErr := collectResponsesSSE(source)
		if collectErr != nil {
			if len(payload) > 0 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write(payload)
				return
			}
			writeRuntimeError(w, http.StatusBadGateway, "upstream_response_invalid", collectErr.Error())
			return
		}
		switch responseMode {
		case "chat-to-responses":
			payload = chatToResponsesResponse(payload, model)
		case "responses-to-chat":
			payload = responsesToChatResponse(payload, model)
		}
		if toolRestorer != nil {
			payload = toolRestorer.restore(payload)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		return
	}
	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	stream := clientStream
	var streamWriter io.Writer = w
	if stream && response.StatusCode < http.StatusBadRequest {
		// net/http buffers small writes. Provider SSE events are often only a few
		// hundred bytes, so a plain io.Copy can otherwise hold several events
		// before the outer relay (and therefore the client) sees anything.
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
			streamWriter = immediateFlushWriter{Writer: w, Flusher: flusher}
		}
	}
	if response.StatusCode >= 400 || (responseMode == "passthrough" && toolRestorer == nil) {
		_, _ = io.Copy(streamWriter, source)
		return
	}
	if stream {
		if responseMode == "passthrough" {
			if toolRestorer != nil {
				_ = restoreToolStream(streamWriter, source, toolRestorer)
			}
			return
		}
		destination := streamWriter
		if toolRestorer != nil {
			destination = toolRestoreWriter{Writer: streamWriter, restorer: toolRestorer}
		}
		_ = translateStream(destination, source, responseMode, model)
		return
	}
	payload, readErr := io.ReadAll(io.LimitReader(source, maxProviderResponseBytes))
	if readErr != nil {
		return
	}
	switch responseMode {
	case "chat-to-responses":
		payload = chatToResponsesResponse(payload, model)
	case "responses-to-chat":
		payload = responsesToChatResponse(payload, model)
	}
	if toolRestorer != nil {
		payload = toolRestorer.restore(payload)
	}
	_, _ = streamWriter.Write(payload)
}

type immediateFlushWriter struct {
	io.Writer
	Flusher http.Flusher
}

func (w immediateFlushWriter) Write(payload []byte) (int, error) {
	written, err := w.Writer.Write(payload)
	if written > 0 {
		w.Flusher.Flush()
	}
	return written, err
}

// responseModelObserver reads the provider body before any protocol translation.
// It retains only one bounded event (or a bounded JSON body), never response text
// in the secret-free request trace.
type responseModelObserver struct {
	stream  bool
	pending []byte
	model   string
}

func (o *responseModelObserver) Write(payload []byte) (int, error) {
	const maxEvent = 2 << 20
	size := len(payload)
	if !o.stream {
		if len(o.pending) < maxEvent {
			o.pending = append(o.pending, payload[:min(len(payload), maxEvent-len(o.pending))]...)
		}
		return size, nil
	}
	for len(payload) > 0 {
		newline := bytes.IndexByte(payload, '\n')
		if newline < 0 {
			if len(o.pending)+len(payload) <= maxEvent {
				o.pending = append(o.pending, payload...)
			}
			break
		}
		if len(o.pending)+newline <= maxEvent {
			o.pending = append(o.pending, payload[:newline]...)
			o.observeLine(o.pending)
		}
		o.pending = o.pending[:0]
		payload = payload[newline+1:]
	}
	return size, nil
}

func (o *responseModelObserver) observeLine(line []byte) {
	line = bytes.TrimSpace(line)
	if bytes.HasPrefix(line, []byte("data:")) {
		line = bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	}
	if !bytes.Contains(line, []byte(`"model"`)) {
		return
	}
	if model := billing.ParseResponse(line).Model; model != "" {
		o.model = model
	}
}

func (o *responseModelObserver) finish() string {
	if o.stream {
		o.observeLine(o.pending)
	} else {
		o.model = billing.ParseResponse(o.pending).Model
	}
	return o.model
}

func canonicalInferencePath(path string) string {
	path = strings.TrimSuffix(path, "/")
	for _, prefix := range []string{"/openai/v1", "/backend-api/codex", "/v1"} {
		if strings.HasPrefix(path, prefix) {
			path = strings.TrimPrefix(path, prefix)
			break
		}
	}
	if path == "" {
		return "/responses"
	}
	return path
}

func isResponsesPath(path string) bool { return path == "/responses" || path == "/responses/compact" }
func isChatPath(path string) bool      { return path == "/chat/completions" || path == "/completions" }

func copyResponseHeaders(destination, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if lower != "content-type" && lower != "retry-after" && lower != "x-request-id" &&
			lower != "request-id" && !strings.HasPrefix(lower, "x-ratelimit-") && !strings.HasPrefix(lower, "openai-") {
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func writeRuntimeError(w http.ResponseWriter, status int, code, message string) {
	source := "relay"
	if code == "upstream_connection_failed" || code == "upstream_response_invalid" {
		source = "upstream"
		message = "Upstream service error: " + message
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Relay-Error-Source", source)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": code, "code": code, "message": message, "source": source}})
}

// Preserve provider error fields while identifying the service that rejected
// the request. Bound reads and avoid exposing HTML gateway pages to API clients.
func writeProviderError(w http.ResponseWriter, response *http.Response) {
	const limit = 64 << 10
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, limit+1))
	var root map[string]any
	if readErr != nil || len(payload) > limit || json.Unmarshal(payload, &root) != nil || root == nil {
		root = make(map[string]any)
		text := strings.TrimSpace(string(payload))
		if readErr == nil && len(payload) <= limit && !strings.HasPrefix(text, "<") {
			root["message"] = text
		}
	}
	value, ok := root["error"].(map[string]any)
	if !ok || value == nil {
		value = make(map[string]any)
		if message, ok := root["error"].(string); ok {
			value["message"] = message
		} else if message, ok := root["message"].(string); ok {
			value["message"] = message
		}
		root["error"] = value
	}
	message, _ := value["message"].(string)
	message = strings.TrimSpace(message)
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}
	if message == "" {
		message = "The upstream service rejected the request."
	}
	value["message"] = "Upstream service error: " + message
	value["source"] = "upstream"
	if value["code"] == nil {
		value["code"] = "upstream_http_error"
	}
	if value["type"] == nil {
		value["type"] = "upstream_error"
	}
	copyResponseHeaders(w.Header(), response.Header)
	w.Header().Del("Content-Length")
	w.Header().Del("Content-Encoding")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Relay-Error-Source", "upstream")
	w.WriteHeader(response.StatusCode)
	_ = json.NewEncoder(w).Encode(root)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func jsonString(payload []byte, key string) string {
	return strings.TrimSpace(gjson.GetBytes(payload, key).String())
}

func jsonBool(payload []byte, key string) bool {
	return gjson.GetBytes(payload, key).Bool()
}

func rewriteJSONModel(payload []byte, model string) []byte {
	if model == "" || jsonString(payload, "model") == model {
		return payload
	}
	var root map[string]any
	if json.Unmarshal(payload, &root) != nil {
		return payload
	}
	root["model"] = model
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	return encoded
}
