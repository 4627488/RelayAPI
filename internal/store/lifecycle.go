package store

import (
	"context"
	"errors"
	"strings"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"gorm.io/gorm"
)

type UpstreamLifecycleInput struct {
	RequestLogID, Event, UpstreamExecutionID, UpstreamTraceID, SourceFormat, ToFormat, Model, RequestedModel string
	ModelAlias, Provider, ExecutorType, AuthType, AuthIndex, ServiceTier, ResponseServiceTier                string
	ReasoningEffort, Outcome, ErrorMessage, Headers, ResponseHeaders                                         string
	Body, OriginalRequest, RequestBody, RawJSON                                                              string
	StatusCode                                                                                               int
}

func (s Store) RecordUpstreamLifecycleEvent(ctx context.Context, input UpstreamLifecycleInput) error {
	event := db.UpstreamLifecycleEvent{
		ID: identity.NewID(), RequestLogID: strings.TrimSpace(input.RequestLogID), Event: input.Event,
		UpstreamExecutionID: input.UpstreamExecutionID, UpstreamTraceID: input.UpstreamTraceID,
		SourceFormat: input.SourceFormat, ToFormat: input.ToFormat, Model: input.Model,
		RequestedModel: input.RequestedModel, ModelAlias: input.ModelAlias, Provider: input.Provider,
		ExecutorType: input.ExecutorType, AuthType: input.AuthType, AuthIndex: input.AuthIndex,
		ServiceTier: input.ServiceTier, ResponseServiceTier: input.ResponseServiceTier,
		ReasoningEffort: input.ReasoningEffort, StatusCode: input.StatusCode, Outcome: input.Outcome,
		ErrorMessage: input.ErrorMessage, Headers: input.Headers, ResponseHeaders: input.ResponseHeaders,
		Body: input.Body, OriginalRequest: input.OriginalRequest, RequestBody: input.RequestBody,
		RawJSON: input.RawJSON,
	}
	if event.RequestLogID == "" || event.Event == "" {
		return errors.New("request log ID and event are required")
	}
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&db.RequestLog{}).Where("id = ?", event.RequestLogID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return applyUpstreamLifecycleEvent(tx, &event, false)
		}
		// Only a compact completion may arrive before Relay has written its
		// request log. Keep it temporarily, then consume it atomically when the
		// request log is created. Large request/response bodies are owned by the
		// request detail record and must never be duplicated here.
		event.Headers = "{}"
		event.ResponseHeaders = "{}"
		event.Body = ""
		event.OriginalRequest = ""
		event.RequestBody = ""
		event.RawJSON = ""
		if err := tx.Create(&event).Error; err != nil {
			return err
		}
		// Close the race where the request log committed between the first
		// existence check and this insert.
		if err := tx.Model(&db.RequestLog{}).Where("id = ?", event.RequestLogID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return applyUpstreamLifecycleEvent(tx, &event, true)
		}
		return nil
	})
}

func applyPendingUpstreamLifecycleEvents(tx *gorm.DB, requestLogID string) error {
	var events []db.UpstreamLifecycleEvent
	if err := tx.Where("request_log_id = ? AND processed = ?", requestLogID, false).
		Order("created_at").Find(&events).Error; err != nil {
		return err
	}
	for index := range events {
		if err := applyUpstreamLifecycleEvent(tx, &events[index], true); err != nil {
			return err
		}
	}
	return nil
}

func applyUpstreamLifecycleEvent(tx *gorm.DB, event *db.UpstreamLifecycleEvent, persisted bool) error {
	updates := map[string]any{}
	put := func(column, value string) {
		if strings.TrimSpace(value) != "" {
			updates[column] = strings.TrimSpace(value)
		}
	}
	put("upstream_execution_id", event.UpstreamExecutionID)
	put("upstream_trace_id", event.UpstreamTraceID)
	// RelayAPI may already have recorded a client-specific API-key alias. Upstream
	// only sees the rewritten model, so its lifecycle event must not erase the
	// original client-visible model in that case.
	if strings.TrimSpace(event.RequestedModel) != "" {
		updates["requested_model"] = gorm.Expr(
			"CASE WHEN model_alias = '' THEN ? ELSE requested_model END",
			strings.TrimSpace(event.RequestedModel),
		)
	}
	put("actual_model", event.Model)
	if strings.TrimSpace(event.ModelAlias) != "" {
		updates["model_alias"] = gorm.Expr(
			"CASE WHEN model_alias = '' THEN ? ELSE model_alias END",
			strings.TrimSpace(event.ModelAlias),
		)
	}
	put("provider", event.Provider)
	put("executor_type", event.ExecutorType)
	put("auth_type", event.AuthType)
	put("auth_index", event.AuthIndex)
	put("service_tier", event.ServiceTier)
	put("response_service_tier", event.ResponseServiceTier)
	put("reasoning_effort", event.ReasoningEffort)
	if event.Outcome != "" && event.Outcome != "succeeded" {
		errorCode := "upstream_" + event.Outcome
		if strings.Contains(strings.ToLower(event.ErrorMessage), "auth_unavailable") {
			errorCode = "auth_unavailable"
		}
		put("error_code", errorCode)
		put("error_message", event.ErrorMessage)
	}
	if len(updates) > 0 {
		if err := tx.Model(&db.RequestLog{}).Where("id = ?", event.RequestLogID).Updates(updates).Error; err != nil {
			return err
		}
	}
	detailUpdates := map[string]any{}
	switch event.Event {
	case "request.intercept_after":
		if event.Headers != "" {
			detailUpdates["forwarded_headers"] = event.Headers
		}
		if event.Body != "" {
			detailUpdates["forwarded_body"] = event.Body
			detailUpdates["forwarded_body_bytes"] = len(event.Body)
		}
	case "response.intercept_after":
		if event.ResponseHeaders != "" {
			detailUpdates["upstream_headers"] = event.ResponseHeaders
		}
		if event.Body != "" {
			detailUpdates["upstream_body"] = event.Body
			detailUpdates["upstream_body_bytes"] = len(event.Body)
		}
		if event.StatusCode != 0 {
			detailUpdates["upstream_status"] = event.StatusCode
		}
	case "request.complete":
		if event.ErrorMessage != "" {
			detailUpdates["error_name"] = "upstream_" + event.Outcome
			detailUpdates["error_message"] = event.ErrorMessage
		}
	}
	if len(detailUpdates) > 0 {
		if err := tx.Model(&db.RequestLogDetail{}).Where("request_log_id = ?", event.RequestLogID).
			Updates(detailUpdates).Error; err != nil {
			return err
		}
	}
	if !persisted {
		return nil
	}
	// The durable request summary/detail now owns all useful information.
	// Removing the temporary enrichment avoids a second lifecycle history and
	// the INSERT+UPDATE write amplification that previously grew TOAST/WAL.
	return tx.Delete(event).Error
}
