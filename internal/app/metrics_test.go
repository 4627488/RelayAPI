package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

func metricsTestApp() *App {
	a := &App{mux: http.NewServeMux()}
	a.initMetrics()
	a.mux.HandleFunc("GET /metrics", a.serveMetrics)
	return a
}

func TestMetricsEndpointAuthAndRegistryIsolation(t *testing.T) {
	a, b := metricsTestApp(), metricsTestApp()
	a.cfg.MetricsToken = "scrape-secret"
	for _, token := range []string{"", "Bearer wrong", "Bearer scrape-secret"} {
		r := httptest.NewRequest("GET", "/metrics", nil)
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if token != "Bearer scrape-secret" {
			if w.Code != 401 || strings.Contains(w.Body.String(), "go_goroutines") {
				t.Fatal("unauthorized scrape exposed metrics", w.Code)
			}
			continue
		}
		if w.Code != 200 || !strings.Contains(w.Body.String(), "go_goroutines") || !strings.Contains(w.Body.String(), "relay_cpa_up 0") {
			t.Fatal(w.Body.String())
		}
		if strings.Contains(w.Body.String(), "scrape-secret") {
			t.Fatal("scrape secret leaked")
		}
	}
	a.observeInference(store.LogInput{RequestType: "responses", StatusCode: 200})
	if testutil.CollectAndCount(b.metrics.requests) != 0 {
		t.Fatal("app registries share counters")
	}
}

func TestMetricsBoundedHTTPRoutesAndStreaming(t *testing.T) {
	a := metricsTestApp()
	a.mux.HandleFunc("GET /api/items/{id}", func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("Flusher lost")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: hello\n\n"))
		flusher.Flush()
	})
	a.mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	for _, path := range []string{"/api/items/private-id", "/api/items/another-id", "/unknown-secret"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	}
	if testutil.ToFloat64(a.metrics.httpRequests.WithLabelValues("GET", "GET /api/items/{id}", "200")) != 2 {
		t.Fatal("route template not counted")
	}
	w := httptest.NewRecorder()
	a.serveMetrics(w, httptest.NewRequest("GET", "/metrics", nil))
	for _, secret := range []string{"private-id", "another-id", "unknown-secret"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("raw URL leaked", secret)
		}
	}
}

func TestMetricsPreservesWebSocketUpgradeAndConnectionGauge(t *testing.T) {
	a := metricsTestApp()
	finished := make(chan struct{})
	a.mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			close(finished)
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
		close(finished)
	})
	s := httptest.NewServer(a.Handler())
	defer s.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	if testutil.ToFloat64(a.metrics.inFlight.WithLabelValues("websocket")) != 1 {
		t.Fatal("active socket missing")
	}
	_ = conn.WriteMessage(websocket.TextMessage, []byte("done"))
	_ = conn.Close()
	<-finished
	deadline := time.Now().Add(time.Second)
	for testutil.ToFloat64(a.metrics.inFlight.WithLabelValues("websocket")) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if testutil.ToFloat64(a.metrics.httpRequests.WithLabelValues("GET", "GET /ws", "101")) != 1 {
		t.Fatal("upgrade not recorded as 101")
	}
}

func TestMetricsInferenceUnitsAndCPAStages(t *testing.T) {
	a := metricsTestApp()
	cost, first := int64(250_000_000), int64(1500)
	input := store.LogInput{RequestType: "responses.websocket", StatusCode: 200, LatencyMS: 2500,
		FirstTokenMS: &first, CostNanoUSD: &cost, PricingComplete: true, Settled: true, Usage: store.Usage{Prompt: 10, Completion: 2, Total: 12}, Model: "private-model", TenantID: "private-tenant"}
	a.observeInference(input)
	input.LogUnit = store.LogUnitConnection
	a.observeInference(input)
	input.LogUnit = store.LogUnitPrewarm
	a.observeInference(input)
	if testutil.ToFloat64(a.metrics.prewarms.WithLabelValues("websocket")) != 1 {
		t.Fatal("prewarm not separated")
	}
	if testutil.ToFloat64(a.metrics.requests.WithLabelValues("responses", "websocket", "200", "complete", "true")) != 1 {
		t.Fatal("connection summary double counted")
	}
	if testutil.ToFloat64(a.metrics.costs.WithLabelValues("websocket")) != .25 {
		t.Fatal("cost units")
	}
	if testutil.ToFloat64(a.metrics.tokens.WithLabelValues("responses", "websocket", "total")) != 12 {
		t.Fatal("tokens")
	}
	now := time.Now()
	a.observeCPAExecution(relaybridge.ExecutionAttempt{Provider: "codex", Kind: "stream", Status: "failed", Error: "request_canceled", StartedAt: now, CompletedAt: now.Add(time.Second), GetConnAt: now, GotConnAt: now.Add(100 * time.Millisecond)})
	if testutil.ToFloat64(a.metrics.executions.WithLabelValues("codex", "stream", "canceled")) != 1 {
		t.Fatal("CPA cancellation missing")
	}
	families, err := a.metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		for _, metric := range family.Metric {
			if family.GetName() == "relay_inference_first_token_seconds" && metric.GetHistogram().GetSampleSum() != 1.5 {
				t.Fatal("latency units")
			}
			for _, label := range metric.Label {
				if strings.Contains(label.GetValue(), "private-") {
					t.Fatal("private label leaked")
				}
			}
		}
	}
}

func TestMetricsConcurrentObservationAndScraping(t *testing.T) {
	a := metricsTestApp()
	admission := gateway.New(gateway.Options{MaxInFlight: 1})
	a.nativeAdmission.Store(admission)
	lease, err := admission.Acquire(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 10 {
				a.observeInference(store.LogInput{RequestType: "responses", StatusCode: 200})
				w := httptest.NewRecorder()
				a.serveMetrics(w, httptest.NewRequest("GET", "/metrics", nil))
				body, _ := io.ReadAll(w.Result().Body)
				// The exporter intentionally rejects scrapes above its concurrency cap.
				if (w.Code != 200 && w.Code != 503) || (w.Code == 200 && !strings.Contains(string(body), "relay_admission_in_flight 1")) {
					t.Error("scrape failed", w.Code)
				}
			}
		})
	}
	wg.Wait()
	if testutil.ToFloat64(a.metrics.requests.WithLabelValues("responses", "http", "200", "incomplete", "false")) != 80 {
		t.Fatal("concurrent increments lost")
	}
}
