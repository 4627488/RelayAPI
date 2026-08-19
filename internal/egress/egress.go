package egress

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

func ValidateProxyURL(raw string) error {
	parsed, err := parseProxyURL(raw)
	if err != nil || parsed == nil {
		return fmt.Errorf("代理地址必须是有效的 HTTP、HTTPS、SOCKS5 或 SOCKS5H URL")
	}
	return nil
}

func OutboundHTTPClient(rawProxy string, timeout time.Duration) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	// Each credential owns a transport. Keep enough warm sockets per provider
	// to avoid putting DNS, TCP and TLS handshakes back on the request hot path
	// during ordinary bursts. Responses are latency-sensitive SSE, so ask
	// providers for identity encoding rather than risking compression buffering.
	transport.MaxIdleConns = 32
	transport.MaxIdleConnsPerHost = 16
	transport.DisableCompression = true
	parsed, err := parseProxyURL(rawProxy)
	if err != nil {
		return nil, err
	}
	if parsed != nil {
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
			transport.Proxy = http.ProxyURL(parsed)
		case "socks5", "socks5h":
			var auth *proxy.Auth
			if parsed.User != nil {
				password, _ := parsed.User.Password()
				auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
			}
			dialer, dialErr := proxy.SOCKS5("tcp", parsed.Host, auth, &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second})
			if dialErr != nil {
				return nil, dialErr
			}
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				if contextDialer, ok := dialer.(proxy.ContextDialer); ok {
					return contextDialer.DialContext(ctx, network, address)
				}
				return dialer.Dial(network, address)
			}
		}
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

func RedactProxyURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User == nil {
		return strings.TrimSpace(raw)
	}
	if parsed.User.Username() != "" {
		parsed.User = url.UserPassword(parsed.User.Username(), "***")
	} else {
		parsed.User = nil
	}
	return parsed.String()
}

func parseProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.EqualFold(raw, "direct") {
		return nil, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid proxy URL")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks5", "socks5h":
		return parsed, nil
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", parsed.Scheme)
	}
}
