package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"gorm.io/gorm"
)

type CPALifecycleInput struct {
	RequestLogID, Event, CPAExecutionID, CPATraceID, SourceFormat, ToFormat, Model, RequestedModel string
	ModelAlias, Provider, ExecutorType, AuthType, AuthIndex, ServiceTier, ResponseServiceTier      string
	ReasoningEffort, Outcome, ErrorMessage, Headers, ResponseHeaders                               string
	Body, OriginalRequest, RequestBody, RawJSON                                                    string
	StatusCode                                                                                     int
}

func (s Store) RecordCPALifecycleEvent(ctx context.Context, input CPALifecycleInput) error {
	event := db.CPALifecycleEvent{
		ID: identity.NewID(), RequestLogID: strings.TrimSpace(input.RequestLogID), Event: input.Event,
		CPAExecutionID: input.CPAExecutionID, CPATraceID: input.CPATraceID,
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
		if err := tx.Create(&event).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&db.RequestLog{}).Where("id = ?", event.RequestLogID).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
		return applyCPALifecycleEvent(tx, &event)
	})
}

func applyPendingCPALifecycleEvents(tx *gorm.DB, requestLogID string) error {
	var events []db.CPALifecycleEvent
	if err := tx.Where("request_log_id = ? AND processed = ?", requestLogID, false).
		Order("created_at").Find(&events).Error; err != nil {
		return err
	}
	for index := range events {
		if err := applyCPALifecycleEvent(tx, &events[index]); err != nil {
			return err
		}
	}
	return nil
}

func applyCPALifecycleEvent(tx *gorm.DB, event *db.CPALifecycleEvent) error {
	updates := map[string]any{}
	put := func(column, value string) {
		if strings.TrimSpace(value) != "" {
			updates[column] = strings.TrimSpace(value)
		}
	}
	put("cpa_execution_id", event.CPAExecutionID)
	put("cpa_trace_id", event.CPATraceID)
	put("requested_model", event.RequestedModel)
	put("actual_model", event.Model)
	put("model_alias", event.ModelAlias)
	put("provider", event.Provider)
	put("executor_type", event.ExecutorType)
	put("auth_type", event.AuthType)
	put("auth_index", event.AuthIndex)
	put("service_tier", event.ServiceTier)
	put("response_service_tier", event.ResponseServiceTier)
	put("reasoning_effort", event.ReasoningEffort)
	if event.Outcome != "" && event.Outcome != "succeeded" {
		errorCode := "cpa_" + event.Outcome
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
			detailUpdates["error_name"] = "cpa_" + event.Outcome
			detailUpdates["error_message"] = event.ErrorMessage
		}
	}
	if len(detailUpdates) > 0 {
		if err := tx.Model(&db.RequestLogDetail{}).Where("request_log_id = ?", event.RequestLogID).
			Updates(detailUpdates).Error; err != nil {
			return err
		}
	}
	now := time.Now()
	// Once the event has enriched the durable request summary/detail, its raw
	// transport payload is redundant and is by far the largest source of TOAST
	// growth. Keep compact lifecycle metadata for diagnostics, but scrub the
	// duplicated bodies immediately.
	return tx.Model(event).Updates(map[string]any{
		"processed": true, "processed_at": &now,
		"headers": "{}", "response_headers": "{}", "body": "",
		"original_request": "", "request_body": "", "raw_json": "",
	}).Error
}
