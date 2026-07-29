package app

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) cpaPluginUsage(w http.ResponseWriter, r *http.Request) {
	if !a.authorizeCPAPlugin(w, r) {
		return
	}
	var record map[string]any
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := decoder.Decode(&record); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "用量事件无效")
		return
	}
	// Usage remains a reconciliation signal. Correlated lifecycle and the
	// downstream terminal response own request enrichment and settlement.
	slog.Info("CPA usage event", "provider", record["Provider"], "model", record["Model"],
		"auth_id", record["AuthID"], "failed", record["Failed"])
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) authorizeCPAPlugin(w http.ResponseWriter, r *http.Request) bool {
	if a.cfg.CPAPluginSecret == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Relay-Plugin-Secret")), []byte(a.cfg.CPAPluginSecret)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "无效的插件凭据")
		return false
	}
	return true
}

type cpaLifecyclePayload struct {
	RequestID       string
	TraceID         string
	SourceFormat    string
	ToFormat        string
	Model           string
	RequestedModel  string
	Stream          bool
	Headers         http.Header
	RequestHeaders  http.Header
	ResponseHeaders http.Header
	Body            []byte
	OriginalRequest []byte
	RequestBody     []byte
	StatusCode      int
	ChunkIndex      int
	Outcome         string
	Error           string
	StartedAt       time.Time
	CompletedAt     time.Time
	Metadata        map[string]any
}

func (a *App) cpaPluginLifecycle(w http.ResponseWriter, r *http.Request) {
	if !a.authorizeCPAPlugin(w, r) {
		return
	}
	var envelope struct {
		Event          string              `json:"event"`
		RelayRequestID string              `json:"relay_request_id"`
		Payload        cpaLifecyclePayload `json:"payload"`
	}
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 3<<20))
	if err := decoder.Decode(&envelope); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "CPA 生命周期事件无效")
		return
	}
	if strings.TrimSpace(envelope.RelayRequestID) == "" || strings.TrimSpace(envelope.Event) == "" {
		writeError(w, http.StatusBadRequest, "invalid_event", "CPA 生命周期事件缺少关联信息")
		return
	}
	payload := envelope.Payload
	headers := payload.Headers
	if len(headers) == 0 {
		headers = payload.RequestHeaders
	}
	body, _, _ := boundedDetail(payload.Body)
	originalRequest, _, _ := boundedDetail(payload.OriginalRequest)
	requestBody, _, _ := boundedDetail(payload.RequestBody)
	raw, _ := json.Marshal(payload)
	if len(raw) > requestLogDetailLimit {
		raw = raw[:requestLogDetailLimit]
	}
	input := store.CPALifecycleInput{
		RequestLogID: envelope.RelayRequestID, Event: envelope.Event,
		CPAExecutionID: payload.RequestID, CPATraceID: payload.TraceID,
		SourceFormat: payload.SourceFormat, ToFormat: payload.ToFormat,
		Model: payload.Model, RequestedModel: payload.RequestedModel,
		ModelAlias:          metadataText(payload.Metadata, "model_alias", "ModelAlias", "alias", "Alias"),
		Provider:            metadataText(payload.Metadata, "provider", "Provider"),
		ExecutorType:        metadataText(payload.Metadata, "executor_type", "ExecutorType"),
		AuthType:            metadataText(payload.Metadata, "auth_type", "AuthType"),
		AuthIndex:           metadataText(payload.Metadata, "auth_index", "AuthIndex"),
		ServiceTier:         metadataText(payload.Metadata, "service_tier", "ServiceTier"),
		ResponseServiceTier: metadataText(payload.Metadata, "response_service_tier", "ResponseServiceTier"),
		ReasoningEffort:     metadataText(payload.Metadata, "reasoning_effort", "ReasoningEffort"),
		StatusCode:          payload.StatusCode, Outcome: payload.Outcome, ErrorMessage: payload.Error,
		Headers: sanitizedHeaders(headers), ResponseHeaders: sanitizedHeaders(payload.ResponseHeaders),
		Body: body, OriginalRequest: originalRequest, RequestBody: requestBody, RawJSON: string(raw),
	}
	if err := a.store.RecordCPALifecycleEvent(r.Context(), input); err != nil {
		slog.Error("record CPA lifecycle", "request_id", envelope.RelayRequestID, "event", envelope.Event, "error", err)
		writeError(w, http.StatusInternalServerError, "database_error", "无法保存 CPA 生命周期事件")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func metadataText(metadata map[string]any, names ...string) string {
	if len(metadata) == 0 {
		return ""
	}
	for key, value := range metadata {
		for _, name := range names {
			if strings.EqualFold(strings.ReplaceAll(key, "-", "_"), strings.ReplaceAll(name, "-", "_")) {
				if text := strings.TrimSpace(fmt.Sprint(value)); text != "" && text != "<nil>" {
					return text
				}
			}
		}
		if nested, ok := value.(map[string]any); ok {
			if text := metadataText(nested, names...); text != "" {
				return text
			}
		}
	}
	return ""
}
