package cpa

import (
	"net/http"
	"testing"
)

func TestTransportForProxyModes(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", "direct", "none", "http://proxy.example:8080", "https://proxy.example:8443", "socks5://proxy.example:1080", "socks5h://user:pass@proxy.example:1080"} {
		value := value
		t.Run(value, func(t *testing.T) {
			t.Parallel()
			transport, err := transportForProxy(value)
			if err != nil || transport == nil {
				t.Fatalf("transportForProxy(%q) = %T, %v", value, transport, err)
			}
		})
	}
}

func TestTransportForProxyRejectsUnsupportedScheme(t *testing.T) {
	t.Parallel()
	if transport, err := transportForProxy("ftp://proxy.example:21"); err == nil || transport != nil {
		t.Fatalf("transportForProxy() = %T, %v; want error", transport, err)
	}
}

func TestDirectTransportDisablesEnvironmentProxy(t *testing.T) {
	t.Parallel()
	roundTripper, err := transportForProxy("direct")
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := roundTripper.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("direct transport = %#v; want Proxy nil", roundTripper)
	}
}
