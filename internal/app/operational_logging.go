package app

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

type operationalContextKey struct{}

func settlementLogLevel(err error) slog.Level {
	if err != nil {
		return slog.LevelError
	}
	return slog.LevelInfo
}

type operationalContext struct {
	requestID string
	tenantID  string
	keyID     string
}

func operationalRequest(r *http.Request) *operationalContext {
	value, _ := r.Context().Value(operationalContextKey{}).(*operationalContext)
	return value
}

func withOperationalRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value := &operationalContext{requestID: identity.NewID()}
		w.Header().Set("X-Relay-Request-ID", value.requestID)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), operationalContextKey{}, value)))
	})
}

func logInference(input store.LogInput) {
	if input.LogUnit == store.LogUnitConnection {
		return
	}
	level := slog.LevelInfo
	if input.LogUnit == store.LogUnitPrewarm {
		level = slog.LevelDebug
	}
	if input.StatusCode >= 500 {
		level = slog.LevelError
	} else if input.StatusCode >= 400 || input.ErrorCode != "" || (!input.PricingComplete && input.LogUnit != store.LogUnitPrewarm) {
		level = slog.LevelWarn
	}
	attrs := []any{"event", "inference.completed", "request_id", input.ID,
		"session_request_id", input.ReservationRequestID, "tenant_id", input.TenantID, "api_key_id", input.APIKeyID,
		"protocol", metricProtocol(input.RequestType), "transport", requestTransport(input.RequestType, input.Stream),
		"model", input.Model, "provider", input.Provider, "credential_id", input.AuthIndex,
		"status", input.StatusCode, "error_code", input.ErrorCode, "duration_ms", input.LatencyMS,
		"usage_quality", input.UsageQuality, "input_tokens", input.Usage.Input, "output_tokens", input.Usage.Output,
		"total_tokens", input.Usage.Total, "pricing_complete", input.PricingComplete,
		"request_bytes", input.RequestBodyBytes, "response_bytes", input.ResponseBodyBytes}
	if input.CostNanoUSD != nil {
		attrs = append(attrs, "assessed_cost_nano_usd", *input.CostNanoUSD)
	}
	if input.FirstTokenMS != nil {
		attrs = append(attrs, "first_token_ms", *input.FirstTokenMS)
	}
	slog.Log(context.Background(), level, "inference completed", attrs...)
}
