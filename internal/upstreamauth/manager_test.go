package upstreamauth

import (
	"testing"
	"time"
)

func TestRefreshDue(t *testing.T) {
	t.Parallel()
	expiring := time.Now().Add(time.Minute).Format(time.RFC3339)
	if !refreshDue("codex", []byte(`{"refresh_token":"r","expired":"`+expiring+`"}`), 5*time.Minute) {
		t.Fatal("expected Codex credential to be due")
	}
	if refreshDue("openai", []byte(`{"refresh_token":"r","expired":"`+expiring+`"}`), 5*time.Minute) {
		t.Fatal("API-key credential must not be refreshed")
	}
}

func TestValidateTokenEndpoint(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ provider, endpoint string }{
		{"codex", "https://auth.openai.com/oauth/token"},
		{"xai", "https://auth.x.ai/oauth/token"},
	} {
		if err := validateTokenEndpoint(test.provider, test.endpoint); err != nil {
			t.Errorf("validateTokenEndpoint(%q, %q): %v", test.provider, test.endpoint, err)
		}
	}
	if err := validateTokenEndpoint("xai", "https://evil.example/token"); err == nil {
		t.Fatal("expected untrusted token endpoint to be rejected")
	}
}
