package config

import "testing"

func TestLoadDoesNotRequireExternalCPAKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/relay")
	t.Setenv("RELAY_SESSION_SECRET", "01234567890123456789012345678901")
	t.Setenv("RELAY_API_KEY_ENCRYPTION_KEY", "01234567890123456789012345678901")
	_, err := Load()
	if err != nil {
		t.Fatal(err)
	}
}
