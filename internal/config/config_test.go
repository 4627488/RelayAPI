package config

import "testing"

func validEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://example.invalid/relay")
	t.Setenv("RELAY_SESSION_SECRET", "01234567890123456789012345678901")
	t.Setenv("RELAY_API_KEY_ENCRYPTION_KEY", "01234567890123456789012345678901")
}

func TestLoadDoesNotRequireExternalCPAKey(t *testing.T) {
	validEnvironment(t)
	_, err := Load()
	if err != nil {
		t.Fatal(err)
	}
}

func TestLoadUsesMemoryBoundedRequestDefaults(t *testing.T) {
	validEnvironment(t)
	t.Setenv("CPA_MAX_REQUEST_MIB", "")
	t.Setenv("CPA_REQUEST_BYTES_IN_FLIGHT_MIB", "")
	t.Setenv("RELAY_EXECUTOR_CACHE_PRESSURE_MIB", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CPAMaxRequestBytes != 32<<20 {
		t.Fatalf("max request bytes = %d, want %d", cfg.CPAMaxRequestBytes, int64(32<<20))
	}
	if cfg.CPARequestBytesInFlight != 32<<20 {
		t.Fatalf("in-flight request bytes = %d, want %d", cfg.CPARequestBytesInFlight, int64(32<<20))
	}
	if cfg.ExecutorCachePressureBytes != 256<<20 {
		t.Fatalf("executor cache pressure = %d, want %d", cfg.ExecutorCachePressureBytes, uint64(256<<20))
	}
}

func TestLoadAllowsVeryLargeRequestBudgets(t *testing.T) {
	validEnvironment(t)
	t.Setenv("CPA_MAX_REQUEST_MIB", "65536")
	t.Setenv("CPA_REQUEST_BYTES_IN_FLIGHT_MIB", "262144")
	t.Setenv("RELAY_EXECUTOR_CACHE_PRESSURE_MIB", "524288")

	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
