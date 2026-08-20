package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

const (
	accountProbeTimeout      = 30 * time.Second
	accountProbePreviewLimit = 400
	accountProbeRequestID    = "admin-account-test"
)

type accountProbeInput struct {
	Model string `json:"model"`
}

type accountProbeResult struct {
	OK         bool   `json:"ok"`
	Model      string `json:"model"`
	Provider   string `json:"provider"`
	StatusCode int    `json:"status_code"`
	LatencyMS  int64  `json:"latency_ms"`
	Preview    string `json:"preview,omitempty"`
	Error      string `json:"error,omitempty"`
}

func (a *App) nativeProviderAccountTest(w http.ResponseWriter, r *http.Request) {
	var input accountProbeInput
	if !decodeJSON(w, r, &input) {
		return
	}
	row, err := a.store.GetUpstreamCredential(r.Context(), strings.TrimSpace(r.PathValue("name")))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "凭据不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "credential_unavailable", "无法读取凭据")
		return
	}
	if !row.Enabled {
		writeError(w, http.StatusConflict, "credential_disabled", "请先启用账户再测试")
		return
	}
	if a.nativeRuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "runtime_unavailable", "运行时不可用")
		return
	}
	model, err := chooseProbeModel(input.Model, row.Models)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), accountProbeTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, probeNativeAccount(ctx, a.nativeRuntime, row, model))
}

func chooseProbeModel(requested string, published []string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		if len(published) == 0 {
			return "", errors.New("账户尚未发布模型")
		}
		return published[0], nil
	}
	for _, model := range published {
		if strings.EqualFold(strings.TrimSpace(model), requested) {
			return model, nil
		}
	}
	return "", errors.New("模型不在该账户的公开范围内")
}

func accountProbeBody(model string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "Reply with the single word pong.",
		}},
		"max_tokens": 16,
		"stream":     false,
	})
	return payload
}

func probeNativeAccount(ctx context.Context, runtime upstream.Runtime, row store.UpstreamCredentialSnapshot, model string) accountProbeResult {
	body := accountProbeBody(model)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body)).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	prepareRuntimeHeaders(request.Header, accountProbeRequestID, row.ID)
	recorder := httptest.NewRecorder()
	started := time.Now()
	runtime.Serve(recorder, request, body)
	latency := time.Since(started)
	status := recorder.Code
	if status == 0 {
		status = http.StatusOK
	}
	preview := probePreview(recorder.Body.Bytes())
	result := accountProbeResult{
		OK:         status >= 200 && status < 300,
		Model:      model,
		Provider:   row.Provider,
		StatusCode: status,
		LatencyMS:  latency.Milliseconds(),
		Preview:    preview,
	}
	if !result.OK {
		result.Error = firstNonEmptyString(preview, boundedErrorText(http.StatusText(status)))
	}
	return result
}

func probePreview(payload []byte) string {
	payload = bytes.TrimSpace(payload)
	if len(payload) == 0 {
		return ""
	}
	var parsed map[string]any
	if json.Unmarshal(payload, &parsed) != nil {
		return clipProbeText(string(payload))
	}
	if text := probeJSONText(parsed["output_text"]); text != "" {
		return clipProbeText(text)
	}
	if choices, ok := parsed["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if message, ok := choice["message"].(map[string]any); ok {
				if text := probeJSONText(message["content"]); text != "" {
					return clipProbeText(text)
				}
			}
			if text := probeJSONText(choice["text"]); text != "" {
				return clipProbeText(text)
			}
		}
	}
	if errObj, ok := parsed["error"].(map[string]any); ok {
		if text := probeJSONText(errObj["message"]); text != "" {
			return clipProbeText(text)
		}
	}
	if text := probeJSONText(parsed["message"]); text != "" {
		return clipProbeText(text)
	}
	encoded, _ := json.Marshal(parsed)
	return clipProbeText(string(encoded))
}

func probeJSONText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok && text != "" {
				parts = append(parts, text)
				continue
			}
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text := probeJSONText(part["text"]); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func clipProbeText(value string) string {
	value = strings.ToValidUTF8(strings.TrimSpace(value), "\uFFFD")
	if utf8.RuneCountInString(value) <= accountProbePreviewLimit {
		return value
	}
	runes := []rune(value)
	return string(runes[:accountProbePreviewLimit])
}
