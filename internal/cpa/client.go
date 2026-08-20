package cpa

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	BaseURL     *url.URL
	APIKey      string
	HTTP        *http.Client
	ControlHTTP *http.Client
	admission   *admissionController
}

func New(rawURL, apiKey string, timeout time.Duration) (*Client, error) {
	return NewWithOptions(rawURL, apiKey, Options{ResponseHeaderTimeout: timeout, MaxQueue: 32})
}

type Options struct {
	ResponseHeaderTimeout   time.Duration
	MaxInFlight             int
	MaxQueue                int
	MaxRequestBytesInFlight int64
	QueueTimeout            time.Duration
	CircuitFailureThreshold int
	CircuitOpenDuration     time.Duration
}

func NewWithOptions(rawURL, apiKey string, options Options) (*Client, error) {
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("CPA URL must be absolute")
	}
	if options.ResponseHeaderTimeout <= 0 {
		options.ResponseHeaderTimeout = 10 * time.Minute
	}
	if options.MaxInFlight <= 0 {
		options.MaxInFlight = 16
	}
	if options.MaxQueue < 0 {
		options.MaxQueue = 0
	}
	if options.MaxRequestBytesInFlight <= 0 {
		options.MaxRequestBytesInFlight = 8 << 30
	}
	if options.QueueTimeout < 0 {
		options.QueueTimeout = 0
	}
	if options.CircuitFailureThreshold <= 0 {
		options.CircuitFailureThreshold = 3
	}
	if options.CircuitOpenDuration <= 0 {
		options.CircuitOpenDuration = 15 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxConnsPerHost = options.MaxInFlight
	transport.MaxIdleConnsPerHost = options.MaxInFlight
	transport.MaxIdleConns = options.MaxInFlight * 2
	transport.ResponseHeaderTimeout = options.ResponseHeaderTimeout
	controlTransport := http.DefaultTransport.(*http.Transport).Clone()
	controlTransport.MaxConnsPerHost = 4
	controlTransport.MaxIdleConnsPerHost = 4
	controlTransport.MaxIdleConns = 8
	controlTransport.ResponseHeaderTimeout = options.ResponseHeaderTimeout
	return &Client{
		BaseURL: base, APIKey: apiKey,
		// A total Client.Timeout breaks long-lived SSE and WebSocket traffic.
		// Bound only the wait for response headers; request contexts own the
		// complete operation lifetime. ControlHTTP is the non-inference pool used
		// by GET /v1/models; it must not share the data-plane connection budget.
		HTTP:        &http.Client{Transport: transport},
		ControlHTTP: &http.Client{Transport: controlTransport},
		admission: newAdmissionController(options.MaxInFlight, options.MaxQueue, options.MaxRequestBytesInFlight, options.QueueTimeout,
			options.CircuitFailureThreshold, options.CircuitOpenDuration),
	}, nil
}

func (c *Client) URL(path string) string {
	return strings.TrimRight(c.BaseURL.String(), "/") + "/" + strings.TrimLeft(path, "/")
}
