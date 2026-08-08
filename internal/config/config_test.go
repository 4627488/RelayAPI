package config

import "testing"

func TestLoadDefaultsToNativeWithoutExternalCPAKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/relay")
	t.Setenv("CPA_API_KEY", "")
	t.Setenv("RELAY_DATA_PLANE", "")
	t.Setenv("RELAY_SESSION_SECRET", "01234567890123456789012345678901")
	t.Setenv("RELAY_API_KEY_ENCRYPTION_KEY", "01234567890123456789012345678901")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataPlane != "native" {
		t.Fatalf("data plane = %q, want native", cfg.DataPlane)
	}
}
