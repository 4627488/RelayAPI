package egress

import (
	"net/http"
	"testing"
)

func TestValidateProxyURL(t *testing.T) {
	for _, value := range []string{"http://proxy.example:8080", "https://proxy.example:8443", "socks5://proxy.example:1080", "socks5h://user:pass@proxy.example:1080"} {
		if err := ValidateProxyURL(value); err != nil {
			t.Fatalf("ValidateProxyURL(%q): %v", value, err)
		}
	}
	for _, value := range []string{"", "direct", "none", "ftp://proxy.example"} {
		if err := ValidateProxyURL(value); err == nil {
			t.Fatalf("ValidateProxyURL(%q) unexpectedly succeeded", value)
		}
	}
}

func TestOutboundHTTPClientWithoutProxyIsDirect(t *testing.T) {
	client, err := OutboundHTTPClient("", 0)
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("transport = %#v, want explicit direct transport", client.Transport)
	}
}
