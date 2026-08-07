package dataplane

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

type TransportPool struct {
	mu                    sync.Mutex
	clients               map[string]*http.Client
	maxConnsPerHost       int
	responseHeaderTimeout time.Duration
}

func NewTransportPool(maxConnsPerHost int, responseHeaderTimeout time.Duration) *TransportPool {
	if maxConnsPerHost <= 0 {
		maxConnsPerHost = 32
	}
	if responseHeaderTimeout <= 0 {
		responseHeaderTimeout = 10 * time.Minute
	}
	return &TransportPool{clients: make(map[string]*http.Client), maxConnsPerHost: maxConnsPerHost, responseHeaderTimeout: responseHeaderTimeout}
}

// Client returns one long-lived client per proxy route. Credentials are never
// part of the key: Authorization belongs to requests, not connection pools.
func (p *TransportPool) Client(proxyURL string) (*http.Client, error) {
	key, parsed, err := normalizeProxyURL(proxyURL)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if client := p.clients[key]; client != nil {
		return client, nil
	}
	transport, err := p.newTransport(parsed, key)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: transport}
	p.clients[key] = client
	return client, nil
}

func (p *TransportPool) CloseIdleConnections() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, client := range p.clients {
		client.CloseIdleConnections()
	}
}

func (p *TransportPool) newTransport(proxyURL *url.URL, key string) (*http.Transport, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxConnsPerHost = p.maxConnsPerHost
	transport.MaxIdleConnsPerHost = p.maxConnsPerHost
	transport.MaxIdleConns = p.maxConnsPerHost * 8
	transport.ResponseHeaderTimeout = p.responseHeaderTimeout
	transport.ForceAttemptHTTP2 = true
	if key == "environment" {
		return transport, nil
	}
	if key == "direct" {
		transport.Proxy = nil
		return transport, nil
	}
	switch strings.ToLower(proxyURL.Scheme) {
	case "http", "https":
		transport.Proxy = http.ProxyURL(proxyURL)
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if proxyURL.User != nil {
			password, _ := proxyURL.User.Password()
			auth = &proxy.Auth{User: proxyURL.User.Username(), Password: password}
		}
		dialer, err := proxy.SOCKS5("tcp", proxyURL.Host, auth, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("create SOCKS5 dialer: %w", err)
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if contextual, ok := dialer.(proxy.ContextDialer); ok {
				return contextual.DialContext(ctx, network, address)
			}
			return dialer.Dial(network, address)
		}
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", proxyURL.Scheme)
	}
	return transport, nil
}

func normalizeProxyURL(raw string) (string, *url.URL, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "environment", nil, nil
	}
	if strings.EqualFold(value, "direct") || strings.EqualFold(value, "none") {
		return "direct", nil, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", nil, fmt.Errorf("invalid proxy URL")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	return parsed.String(), parsed, nil
}
