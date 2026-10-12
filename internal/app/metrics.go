package app

import (
	"bufio"
	"crypto/subtle"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/felixge/httpsnoop"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

var latencyBuckets = []float64{.005, .025, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600, 86400}

type appMetrics struct {
	admissionDuration                                                                                    *prometheus.HistogramVec
	admissionOutcomes, prewarms, usageQuality                                                            *prometheus.CounterVec
	registry                                                                                             *prometheus.Registry
	handler                                                                                              http.Handler
	httpRequests, requests, tokens, costs, persistence, executions, jobs                                 *prometheus.CounterVec
	httpDuration, latency, firstByte, firstToken, sizes, executionDuration, executionStages, jobDuration *prometheus.HistogramVec
	inFlight                                                                                             *prometheus.GaugeVec
	jobSuccess                                                                                           *prometheus.GaugeVec
}

func (a *App) initMetrics() {
	m := &appMetrics{registry: prometheus.NewRegistry()}
	counter := func(name, help string, labels ...string) *prometheus.CounterVec {
		v := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "relay_" + name, Help: help}, labels)
		m.registry.MustRegister(v)
		return v
	}
	histogram := func(name, help string, buckets []float64, labels ...string) *prometheus.HistogramVec {
		v := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "relay_" + name, Help: help, Buckets: buckets}, labels)
		m.registry.MustRegister(v)
		return v
	}
	m.httpRequests = counter("http_requests_total", "Completed HTTP requests, including WebSocket connection lifetimes.", "method", "route", "status")
	m.httpDuration = histogram("http_request_duration_seconds", "HTTP handler duration; WebSocket measures connection lifetime.", latencyBuckets, "method", "route")
	m.inFlight = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "relay_http_in_flight", Help: "Active HTTP handlers and WebSocket connections."}, []string{"transport"})
	m.registry.MustRegister(m.inFlight)
	m.requests = counter("inference_requests_total", "Observed inference outcomes; WebSocket counts each durable turn once.", "protocol", "transport", "status", "pricing", "settled")
	m.prewarms = counter("prewarm_requests_total", "Non-generation prewarm outcomes excluded from inference totals.", "transport")
	m.usageQuality = counter("inference_usage_quality_total", "Inference token accounting quality; unknown is not zero usage.", "transport", "quality")
	m.admissionOutcomes = counter("admission_requests_total", "Admission attempts across settings reloads.", "outcome")
	m.admissionDuration = histogram("admission_wait_seconds", "Time acquiring concurrency and body memory admission.", latencyBuckets, "outcome")
	m.latency = histogram("inference_duration_seconds", "Inference completion duration, excluding finalization.", latencyBuckets, "protocol", "transport")
	m.firstByte = histogram("inference_first_byte_seconds", "Time to first upstream event, when observed.", latencyBuckets, "protocol", "transport")
	m.firstToken = histogram("inference_first_token_seconds", "Time to first generated content, when observed.", latencyBuckets, "protocol", "transport")
	m.sizes = histogram("inference_body_bytes", "Inference payload sizes; WebSocket sizes are per turn.", []float64{1024, 16384, 65536, 262144, 1048576, 8388608, 67108864, 1073741824}, "direction", "transport")
	m.tokens = counter("inference_tokens_total", "Observed usage buckets overlap; total is the provider accounting total.", "protocol", "transport", "kind")
	m.costs = counter("billing_cost_usd_total", "Settled inference charges in USD; not an accounting ledger.", "transport")
	m.persistence = counter("persistence_operations_total", "Request accounting/log persistence outcomes.", "operation", "outcome")
	m.executions = counter("cpa_execution_attempts_total", "Actual CPA executor invocations, including retry attempts and token counting.", "provider", "kind", "outcome")
	m.executionDuration = histogram("cpa_execution_duration_seconds", "CPA executor attempt duration, including streamed output.", latencyBuckets, "provider", "kind")
	m.executionStages = histogram("cpa_execution_stage_seconds", "Observed CPA transport and response stage duration; absent stages are omitted.", latencyBuckets, "provider", "stage")
	m.jobs = counter("background_jobs_total", "Background job executions.", "task", "outcome")
	m.jobDuration = histogram("background_job_duration_seconds", "Background job duration.", latencyBuckets, "task")
	m.jobSuccess = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "relay_background_job_last_success_timestamp_seconds", Help: "Last successful job completion, in Unix seconds."}, []string{"task"})
	m.registry.MustRegister(m.jobSuccess, collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}), &runtimeMetricsCollector{app: a})
	m.handler = promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{EnableOpenMetrics: true, MaxRequestsInFlight: 2})
	a.metrics = m
}

func (a *App) serveMetrics(w http.ResponseWriter, r *http.Request) {
	if token := a.cfg.MetricsToken; token != "" {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	if a.metrics == nil {
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	a.metrics.handler.ServeHTTP(w, r)
}

func (a *App) observeHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.metrics == nil || r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		transport := "http"
		if isWebSocketUpgrade(r) {
			transport = "websocket"
		}
		gauge := a.metrics.inFlight.WithLabelValues(transport)
		gauge.Inc()
		defer gauge.Dec()
		// httpsnoop preserves optional interfaces such as Hijacker and Flusher.
		hijacked := false
		wrapped := httpsnoop.Wrap(w, httpsnoop.Hooks{Hijack: func(next httpsnoop.HijackFunc) httpsnoop.HijackFunc {
			return func() (net.Conn, *bufio.ReadWriter, error) {
				conn, rw, err := next()
				if err == nil {
					hijacked = true
				}
				return conn, rw, err
			}
		}})
		result := httpsnoop.CaptureMetrics(next, wrapped, r)
		if hijacked && transport == "websocket" {
			result.Code = http.StatusSwitchingProtocols
		}
		route := r.Pattern
		if route == "" || route == "/" {
			route = "unmatched"
		}
		method := r.Method
		switch method {
		case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
		default:
			method = "other"
		}
		a.metrics.httpRequests.WithLabelValues(method, route, strconv.Itoa(result.Code)).Inc()
		a.metrics.httpDuration.WithLabelValues(method, route).Observe(result.Duration.Seconds())
	})
}

func (a *App) observeInference(input store.LogInput) {
	if a.metrics == nil || input.LogUnit == store.LogUnitConnection {
		return
	}
	m := a.metrics
	protocol := metricProtocol(input.RequestType)
	transport := requestTransport(input.RequestType, input.Stream)
	if input.LogUnit == store.LogUnitPrewarm {
		m.prewarms.WithLabelValues(transport).Inc()
		return
	}
	quality := input.UsageQuality
	switch quality {
	case "complete", "incomplete", "inconsistent", "unclassified", "missing", "not_generated":
	default:
		quality = "unknown"
	}
	m.usageQuality.WithLabelValues(transport, quality).Inc()
	pricing := "incomplete"
	if input.PricingComplete {
		pricing = "complete"
	}
	m.requests.WithLabelValues(protocol, transport, strconv.Itoa(input.StatusCode), pricing, strconv.FormatBool(input.Settled)).Inc()
	m.latency.WithLabelValues(protocol, transport).Observe(float64(max64(0, input.LatencyMS)) / 1000)
	if input.TTFTMS != nil {
		m.firstByte.WithLabelValues(protocol, transport).Observe(float64(max64(0, *input.TTFTMS)) / 1000)
	}
	if input.FirstTokenMS != nil {
		m.firstToken.WithLabelValues(protocol, transport).Observe(float64(max64(0, *input.FirstTokenMS)) / 1000)
	}
	for kind, value := range map[string]int64{"input": input.Usage.Prompt, "output": input.Usage.Completion, "cached": input.Usage.Cached, "cache_write": input.Usage.CacheWrite, "reasoning": input.Usage.Reasoning, "total": input.Usage.Total, "image_input": input.Usage.ImageInput, "cached_image_input": input.Usage.CachedImageInput, "image_output": input.Usage.ImageOutput} {
		m.tokens.WithLabelValues(protocol, transport, kind).Add(float64(max64(0, value)))
	}
	for direction, value := range map[string]int64{"request": input.RequestBodyBytes, "forwarded": input.ForwardedBodyBytes, "response": input.ResponseBodyBytes} {
		m.sizes.WithLabelValues(direction, transport).Observe(float64(max64(0, value)))
	}
	if input.Settled && input.CostNanoUSD != nil {
		m.costs.WithLabelValues(transport).Add(float64(max64(0, *input.CostNanoUSD)) / 1e9)
	}
}

func metricProtocol(value string) string {
	for _, protocol := range []string{"responses", "chat.completions", "embeddings", "images", "messages", "videos", "realtime"} {
		if strings.Contains(value, protocol) {
			return protocol
		}
	}
	return "other"
}

func metricProvider(value string) string {
	switch value {
	case "codex", "openai", "openai-compatibility", "claude", "gemini", "gemini-cli", "antigravity", "kimi", "xai", "qwen", "iflow", "vertex":
		return value
	}
	return "other"
}

func (a *App) observeCPAExecution(attempt relaybridge.ExecutionAttempt) {
	if a.metrics == nil {
		return
	}
	m := a.metrics
	provider := metricProvider(attempt.Provider)
	outcome := "success"
	if attempt.Status != "complete" {
		outcome = "failure"
	}
	if attempt.Error == "request_canceled" {
		outcome = "canceled"
	}
	m.executions.WithLabelValues(provider, attempt.Kind, outcome).Inc()
	m.executionDuration.WithLabelValues(provider, attempt.Kind).Observe(attempt.CompletedAt.Sub(attempt.StartedAt).Seconds())
	for stage, pair := range map[string][2]time.Time{
		"connection_wait": {attempt.GetConnAt, attempt.GotConnAt}, "dns": {attempt.DNSStartedAt, attempt.DNSCompletedAt},
		"connect": {attempt.ConnectStartedAt, attempt.ConnectCompletedAt}, "tls": {attempt.TLSStartedAt, attempt.TLSCompletedAt},
		"upstream_first_byte": {attempt.RequestWrittenAt, attempt.FirstResponseAt}, "headers": {attempt.StartedAt, attempt.HeadersAt},
		"first_chunk": {attempt.StartedAt, attempt.FirstChunkAt},
	} {
		if !pair[0].IsZero() && !pair[1].IsZero() && !pair[1].Before(pair[0]) {
			m.executionStages.WithLabelValues(provider, stage).Observe(pair[1].Sub(pair[0]).Seconds())
		}
	}
}

func (a *App) observePersistence(operation string, err error) {
	if a.metrics == nil {
		return
	}
	outcome := "success"
	if err != nil {
		outcome = "failure"
	}
	a.metrics.persistence.WithLabelValues(operation, outcome).Inc()
}

func (a *App) observeJob(job string, started time.Time, err error) {
	if a.metrics == nil {
		return
	}
	outcome := "success"
	if err != nil {
		outcome = "failure"
	}
	a.metrics.jobs.WithLabelValues(job, outcome).Inc()
	a.metrics.jobDuration.WithLabelValues(job).Observe(time.Since(started).Seconds())
	if err == nil {
		a.metrics.jobSuccess.WithLabelValues(job).Set(float64(time.Now().Unix()))
	}
}
