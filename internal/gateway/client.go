package gateway

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client combines Relay's local admission controller with the transport used
// to invoke the native provider runtime. It has no external control-plane API.
type Client struct {
	BaseURL   *url.URL
	APIKey    string
	HTTP      *http.Client
	admission *admissionController
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
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("runtime URL must be absolute")
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
	return &Client{
		BaseURL: base, APIKey: apiKey, HTTP: &http.Client{Transport: transport},
		admission: newAdmissionController(options.MaxInFlight, options.MaxQueue, options.MaxRequestBytesInFlight, options.QueueTimeout, options.CircuitFailureThreshold, options.CircuitOpenDuration),
	}, nil
}

func (c *Client) URL(path string) string {
	return strings.TrimRight(c.BaseURL.String(), "/") + "/" + strings.TrimLeft(path, "/")
}
