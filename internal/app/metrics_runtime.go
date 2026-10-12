package app

import (
	"github.com/prometheus/client_golang/prometheus"
)

type runtimeMetricsCollector struct{ app *App }

var runtimeMetricDescriptions = map[string]*prometheus.Desc{
	"admission_in_flight":              metricDesc("admission_in_flight", "Requests holding a slot in the current admission controller."),
	"admission_capacity":               metricDesc("admission_capacity", "Current admission slot limit."),
	"admission_queue_depth":            metricDesc("admission_queue_depth", "Requests waiting for an admission slot."),
	"admission_queue_capacity":         metricDesc("admission_queue_capacity", "Admission waiter limit."),
	"admission_request_bytes":          metricDesc("admission_request_bytes", "Request memory reserved by current admission leases."),
	"admission_request_capacity_bytes": metricDesc("admission_request_capacity_bytes", "Admission request memory budget."),
	"admission_rejected_since_reload":  metricDesc("admission_rejected_since_reload", "Rejected requests in the current controller; resets on settings reload."),
	"admission_consecutive_failures":   metricDesc("admission_consecutive_failures", "Current global circuit failure streak."),
	"admission_circuit_state":          metricDesc("admission_circuit_state", "Global circuit state: closed=0, half_open=1, open=2."),
	"admission_retry_after_seconds":    metricDesc("admission_retry_after_seconds", "Remaining global circuit cooldown."),
	"finalization_in_flight":           metricDesc("finalization_in_flight", "Active asynchronous response finalizers; excludes synchronous overflow."),
	"finalization_capacity":            metricDesc("finalization_capacity", "Asynchronous finalizer capacity."),
	"cpa_up":                           metricDesc("cpa_up", "Embedded CPA runtime is installed and has no listener error."),
	"cpa_credentials":                  prometheus.NewDesc("relay_cpa_credentials", "CPA credential counts by provider and condition; conditions overlap.", []string{"provider", "condition"}, nil),
	"db_connections":                   prometheus.NewDesc("relay_db_connections", "SQL connection pool snapshot.", []string{"state"}, nil),
	"db_max_connections":               metricDesc("db_max_connections", "SQL pool maximum open connections; zero means unlimited."),
	"db_wait_total":                    metricDesc("db_wait_total", "SQL connection pool waits since process start."),
	"db_wait_duration_seconds_total":   metricDesc("db_wait_duration_seconds_total", "Cumulative SQL connection pool wait time."),
	"db_closed_connections_total":      prometheus.NewDesc("relay_db_closed_connections_total", "SQL connections closed by pool limits.", []string{"reason"}, nil),
}

func metricDesc(name, help string) *prometheus.Desc {
	return prometheus.NewDesc("relay_"+name, help, nil, nil)
}

func (c *runtimeMetricsCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range runtimeMetricDescriptions {
		ch <- desc
	}
}

func (c *runtimeMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	a := c.app
	emit := func(name string, kind prometheus.ValueType, value float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(runtimeMetricDescriptions[name], kind, value, labels...)
	}
	gauge := func(name string, value float64) { emit(name, prometheus.GaugeValue, value) }
	if admission := a.admission(); admission != nil {
		s := admission.AdmissionStatus()
		gauge("admission_in_flight", float64(s.InFlight))
		gauge("admission_capacity", float64(s.MaxInFlight))
		gauge("admission_queue_depth", float64(s.QueueDepth))
		gauge("admission_queue_capacity", float64(s.MaxQueue))
		gauge("admission_request_bytes", float64(s.RequestBytes))
		gauge("admission_request_capacity_bytes", float64(s.MaxRequestBytes))
		gauge("admission_rejected_since_reload", float64(s.Rejected))
		gauge("admission_consecutive_failures", float64(s.ConsecutiveFailure))
		state := 0.
		if s.Circuit == "half_open" {
			state = 1
		}
		if s.Circuit == "open" {
			state = 2
		}
		gauge("admission_circuit_state", state)
		gauge("admission_retry_after_seconds", float64(s.RetryAfterMS)/1000)
	}
	gauge("finalization_in_flight", float64(len(a.finalizationSlots)))
	gauge("finalization_capacity", float64(cap(a.finalizationSlots)))
	up := 0.
	if a.nativeCPARuntime != nil && a.nativeCPAServeErr.Load() == nil {
		up = 1
	}
	gauge("cpa_up", up)
	// Aggregate aliases that normalize to the same bounded provider label.
	groups := make(map[string]map[string]int)
	if a.nativeCPARuntime != nil {
		for _, s := range a.nativeCPARuntime.CredentialHealthSnapshot() {
			provider := metricProvider(s.Provider)
			if groups[provider] == nil {
				groups[provider] = make(map[string]int)
			}
			for condition, count := range map[string]int{"enabled": s.Enabled, "disabled": s.Disabled, "unavailable": s.Unavailable, "quota_exceeded": s.QuotaExceeded, "cooling": s.Cooling} {
				groups[provider][condition] += count
			}
		}
	}
	for provider, counts := range groups {
		for condition, count := range counts {
			emit("cpa_credentials", prometheus.GaugeValue, float64(count), provider, condition)
		}
	}
	if a.store.DB != nil {
		if database, err := a.store.DB.DB(); err == nil {
			s := database.Stats()
			for state, count := range map[string]int{"open": s.OpenConnections, "in_use": s.InUse, "idle": s.Idle} {
				emit("db_connections", prometheus.GaugeValue, float64(count), state)
			}
			gauge("db_max_connections", float64(s.MaxOpenConnections))
			emit("db_wait_total", prometheus.CounterValue, float64(s.WaitCount))
			emit("db_wait_duration_seconds_total", prometheus.CounterValue, s.WaitDuration.Seconds())
			for reason, count := range map[string]int64{"idle_limit": s.MaxIdleClosed, "idle_time": s.MaxIdleTimeClosed, "lifetime": s.MaxLifetimeClosed} {
				emit("db_closed_connections_total", prometheus.CounterValue, float64(count), reason)
			}
		}
	}
}
