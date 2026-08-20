package cpa

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

// ValidateProxyURL accepts only concrete reusable proxy endpoints. Direct
// routing is represented by no selected proxy rather than by a magic URL.
func ValidateProxyURL(raw string) error {
	setting, err := proxyutil.Parse(strings.TrimSpace(raw))
	if err != nil || setting.Mode != proxyutil.ModeProxy {
		return fmt.Errorf("代理地址必须是有效的 HTTP、HTTPS、SOCKS5 或 SOCKS5H URL")
	}
	return nil
}

// OutboundHTTPClient builds all Relay-owned outbound clients with CPA's proxy
// implementation. No selected proxy means explicit direct access and never
// silently inherits process environment proxy variables.
func OutboundHTTPClient(rawProxy string, timeout time.Duration) (*http.Client, error) {
	value := strings.TrimSpace(rawProxy)
	if value == "" {
		value = "direct"
	}
	transport, _, err := proxyutil.BuildHTTPTransport(value)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

func RedactProxyURL(raw string) string { return proxyutil.Redact(strings.TrimSpace(raw)) }
