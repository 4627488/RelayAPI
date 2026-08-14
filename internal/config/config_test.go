package config

import "testing"

func validEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://example.invalid/relay")
	t.Setenv("RELAY_SESSION_SECRET", "01234567890123456789012345678901")
	t.Setenv("RELAY_API_KEY_ENCRYPTION_KEY", "01234567890123456789012345678901")
}

func TestLoadDoesNotRequireExternalUpstreamKey(t *testing.T) {
	validEnvironment(t)
	_, err := Load()
	if err != nil {
		t.Fatal(err)
	}
}

func TestLoadUsesMemoryBoundedRequestDefaults(t *testing.T) {
	validEnvironment(t)
	t.Setenv("RELAY_MAX_REQUEST_MIB", "")
	t.Setenv("RELAY_REQUEST_BYTES_IN_FLIGHT_MIB", "")
	t.Setenv("RELAY_MEMORY_RECLAIM_THRESHOLD_MIB", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxRequestBytes != 32<<20 {
		t.Fatalf("max request bytes = %d, want %d", cfg.MaxRequestBytes, int64(32<<20))
	}
	if cfg.RequestBytesInFlight != 32<<20 {
		t.Fatalf("in-flight request bytes = %d, want %d", cfg.RequestBytesInFlight, int64(32<<20))
	}
	if cfg.MemoryReclaimThresholdBytes != 256<<20 {
		t.Fatalf("memory reclaim threshold = %d, want %d", cfg.MemoryReclaimThresholdBytes, uint64(256<<20))
	}
}

func TestLoadAllowsVeryLargeRequestBudgets(t *testing.T) {
	validEnvironment(t)
	t.Setenv("RELAY_MAX_REQUEST_MIB", "65536")
	t.Setenv("RELAY_REQUEST_BYTES_IN_FLIGHT_MIB", "262144")
	t.Setenv("RELAY_MEMORY_RECLAIM_THRESHOLD_MIB", "524288")

	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
