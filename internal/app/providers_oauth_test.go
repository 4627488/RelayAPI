package app

import "testing"

func TestValidateOAuthProxyURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "empty", value: ""},
		{name: "direct", value: "direct"},
		{name: "socks5", value: "socks5://user:pass@proxy.example:1080"},
		{name: "socks5h", value: "socks5h://proxy.example:1080"},
		{name: "http", value: "http://proxy.example:8080"},
		{name: "missing host", value: "socks5://", wantErr: true},
		{name: "unsupported", value: "ftp://proxy.example", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateOAuthProxyURL(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateOAuthProxyURL(%q) error = %v, wantErr %v", test.value, err, test.wantErr)
			}
		})
	}
}
