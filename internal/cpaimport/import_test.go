package cpaimport

import "testing"

func TestCredentialProxyOnlyReadsExplicitCredentialValue(t *testing.T) {
	if got := credentialProxy(map[string]any{"proxy_url": " socks5://proxy:1080 "}); got != "socks5://proxy:1080" {
		t.Fatalf("proxy = %q", got)
	}
	if got := credentialProxy(map[string]any{"_relay_proxy_url": "http://legacy:8080"}); got != "" {
		t.Fatalf("legacy proxy leaked into current import logic: %q", got)
	}
}
