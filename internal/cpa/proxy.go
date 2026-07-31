package cpa

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

func (c *Client) OutboundHTTPClient(ctx context.Context, timeout time.Duration) (*http.Client, error) {
	if strings.TrimSpace(c.ManagementKey) == "" {
		return &http.Client{Timeout: timeout}, nil
	}
	status, payload, err := c.Management(ctx, http.MethodGet, "proxy-url", nil)
	if err != nil {
		return nil, fmt.Errorf("read CPA global proxy: %w", err)
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("read CPA global proxy: status %d", status)
	}
	var response struct {
		ProxyURL string `json:"proxy-url"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("decode CPA global proxy: %w", err)
	}
	transport, err := transportForProxy(response.ProxyURL)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

func transportForProxy(raw string) (http.RoundTripper, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return http.DefaultTransport, nil
	}
	if strings.EqualFold(value, "direct") || strings.EqualFold(value, "none") {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		return transport, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid CPA global proxy URL")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		transport.Proxy = http.ProxyURL(parsed)
		return transport, nil
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if parsed.User != nil {
			password, _ := parsed.User.Password()
			auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
		}
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("create CPA SOCKS5 dialer: %w", err)
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if contextDialer, ok := dialer.(proxy.ContextDialer); ok {
				return contextDialer.DialContext(ctx, network, address)
			}
			return dialer.Dial(network, address)
		}
		return transport, nil
	default:
		return nil, fmt.Errorf("unsupported CPA global proxy scheme %q", parsed.Scheme)
	}
}
