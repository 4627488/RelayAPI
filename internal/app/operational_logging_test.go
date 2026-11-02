package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestOperationalRequestCorrelationWithoutMetrics(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	a := &App{mux: http.NewServeMux()}
	a.mux.HandleFunc("POST /api/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		op := operationalRequest(r)
		if op == nil || op.requestID == "" {
			t.Fatal("missing request correlation")
		}
		op.tenantID = "actor-1"
		w.WriteHeader(http.StatusNoContent)
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/items/private-id?key=query-secret", strings.NewReader("private-body"))
	r.Header.Set("X-Relay-Request-ID", "untrusted-id")
	r.Header.Set("Authorization", "Bearer header-secret")
	a.Handler().ServeHTTP(w, r)
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["request_id"] != w.Header().Get("X-Relay-Request-ID") || event["tenant_id"] != "actor-1" || event["route"] != "POST /api/items/{id}" || event["status"] != float64(204) {
		t.Fatalf("invalid HTTP summary: %v", event)
	}
	for _, secret := range []string{"private-id", "query-secret", "private-body", "header-secret", "untrusted-id"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("HTTP summary leaked %s", secret)
		}
	}
}

func TestOperationalHealthNoiseAndPanic(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	a := &App{mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	a.mux.HandleFunc("GET /panic", func(http.ResponseWriter, *http.Request) { panic("test failure") })
	a.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/healthz", nil))
	if output.Len() != 0 {
		t.Fatal("successful health check is noisy")
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/panic", nil))
	if w.Code != 500 || !strings.Contains(output.String(), "http.panic") || !strings.Contains(output.String(), "http.completed") || !strings.Contains(output.String(), w.Header().Get("X-Relay-Request-ID")) {
		t.Fatal("panic missing correlated error log")
	}
}

func TestInferenceSummaryDoesNotClaimDurableSettlement(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	logInference(store.LogInput{LogUnit: store.LogUnitPrewarm, StatusCode: 200})
	logInference(store.LogInput{LogUnit: store.LogUnitConnection, StatusCode: 200})
	if output.Len() != 0 {
		t.Fatal("prewarm or connection summary created inference noise")
	}
	cost := int64(100)
	// HTTP emits this summary before committing the settlement transaction.
	logInference(store.LogInput{ID: "request-1", StatusCode: 200, PricingComplete: true, Settled: true, CostNanoUSD: &cost})
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["assessed_cost_nano_usd"] != float64(100) || event["event"] != "inference.completed" {
		t.Fatal("missing assessed cost")
	}
	if _, exists := event["settled"]; exists {
		t.Fatal("pre-commit summary claimed durable settlement")
	}
}
