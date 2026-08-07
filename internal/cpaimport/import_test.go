package cpaimport

import (
	"encoding/json"
	"testing"
)

func TestInheritRelayProxy(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		document map[string]any
		global   string
		existing map[string]any
		want     string
	}{
		{name: "global proxy", document: map[string]any{}, global: "socks5://global:1080", want: "socks5://global:1080"},
		{name: "existing relay proxy", document: map[string]any{}, existing: map[string]any{"_relay_proxy_url": "http://existing:8080"}, want: "http://existing:8080"},
		{name: "explicit credential wins", document: map[string]any{"proxy_url": "socks5://credential:1080"}, global: "http://global:8080", want: "socks5://credential:1080"},
		{name: "global wins over existing", document: map[string]any{}, global: "http://new:8080", existing: map[string]any{"_relay_proxy_url": "http://old:8080"}, want: "http://new:8080"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var existing []byte
			if test.existing != nil {
				existing, _ = json.Marshal(test.existing)
			}
			inheritRelayProxy(test.document, test.global, existing)
			if got := credentialProxy(test.document); got != test.want {
				t.Fatalf("proxy = %q, want %q", got, test.want)
			}
		})
	}
}
