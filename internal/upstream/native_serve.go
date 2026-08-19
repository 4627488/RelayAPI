package upstream

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

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
	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	stream := jsonBool(body, "stream")
	streamWriter := io.Writer(w)
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
		_, _ = io.Copy(streamWriter, response.Body)
		return
	}
	if stream {
		if responseMode == "passthrough" {
			if toolRestorer != nil {
				_ = restoreToolStream(streamWriter, response.Body, toolRestorer)
			}
			return
		}
		destination := streamWriter
		if toolRestorer != nil {
			destination = toolRestoreWriter{Writer: streamWriter, restorer: toolRestorer}
		}
		_ = translateStream(destination, response.Body, responseMode, model)
		return
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxProviderResponseBytes))
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
	_, _ = w.Write(payload)
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": code, "code": code, "message": message}})
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
