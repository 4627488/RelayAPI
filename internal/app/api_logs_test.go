package app

import (
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestPublicLogDetailRedactsInternalFields(t *testing.T) {
	reservationID := "reservation-secret"
	parentID := "subscription-secret"
	item := store.LogWithDetail{
		Log: db.RequestLog{
			TenantID: "tenant-secret", APIKeyID: "key-secret", ReservationRequestID: &reservationID,
			CPATraceID: "trace-secret", Provider: "provider-secret", AuthIndex: "auth-secret",
			ParentSubscriptionID: &parentID, CredentialEmail: "credential@example.com",
			PriceSource: "internal-price", PriceModel: "internal-model", InputPriceNanoUSD: 42, PricingComplete: true, Settled: true, ReservedNanoUSD: 99, ForwardedBodyBytes: 17,
			StageTimings: `{"internal":1}`, ErrorMessage: "internal failure detail",
		},
		Detail: &db.RequestLogDetail{
			RequestHeaders: `{"Content-Type":["application/json"]}`, RequestBody: `{"prompt":"tenant-owned"}`,
			ForwardedHeaders: `{"Authorization":["secret"]}`, ForwardedBody: `{"internal":true}`, ForwardedBodyBytes: 17,
			UpstreamHeaders: `{"X-Provider-Secret":["secret"]}`, UpstreamBody: `{"answer":"tenant-owned"}`,
			ErrorStack: "secret stack", ErrorCause: "secret cause", ErrorDetail: "secret detail", StageTimings: `{"internal":1}`,
		},
	}

	got := publicLogDetail(item)
	if got.Log.TenantID != "" || got.Log.APIKeyID != "" || got.Log.ReservationRequestID != nil || got.Log.CPATraceID != "" ||
		got.Log.Provider != "" || got.Log.AuthIndex != "" || got.Log.ParentSubscriptionID != nil || got.Log.CredentialEmail != "" ||
		got.Log.PriceSource != "" || got.Log.PriceModel != "" || got.Log.InputPriceNanoUSD != 0 || got.Log.PricingComplete || got.Log.Settled ||
		got.Log.ReservedNanoUSD != 0 || got.Log.ForwardedBodyBytes != 0 || got.Log.StageTimings != "{}" || got.Log.ErrorMessage != "" {
		t.Fatalf("public log leaked internal fields: %#v", got.Log)
	}
	if got.Detail.ForwardedHeaders != "{}" || got.Detail.ForwardedBody != "" || got.Detail.ForwardedBodyBytes != 0 ||
		got.Detail.UpstreamHeaders != "{}" || got.Detail.ErrorStack != "" || got.Detail.ErrorCause != "" || got.Detail.ErrorDetail != "" || got.Detail.StageTimings != "{}" {
		t.Fatalf("public detail leaked internal fields: %#v", got.Detail)
	}
	if got.Detail.RequestBody == "" || got.Detail.UpstreamBody == "" {
		t.Fatalf("tenant-owned payloads were removed: %#v", got.Detail)
	}
}
