package cpa

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const maxControlResponseBytes int64 = 256 << 20

type Client struct {
	BaseURL       *url.URL
	APIKey        string
	ManagementKey string
	HTTP          *http.Client
	ControlHTTP   *http.Client
	admission     *admissionController
}

func New(rawURL, apiKey, managementKey string, timeout time.Duration) (*Client, error) {
	return NewWithOptions(rawURL, apiKey, managementKey, Options{ResponseHeaderTimeout: timeout, MaxQueue: 32})
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

func NewWithOptions(rawURL, apiKey, managementKey string, options Options) (*Client, error) {
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
		BaseURL: base, APIKey: apiKey, ManagementKey: managementKey,
		// A total Client.Timeout breaks long-lived SSE and WebSocket traffic.
		// Bound only the wait for response headers; request contexts own the
		// complete operation lifetime.
		HTTP:        &http.Client{Transport: transport},
		ControlHTTP: &http.Client{Transport: controlTransport},
		admission: newAdmissionController(options.MaxInFlight, options.MaxQueue, options.MaxRequestBytesInFlight, options.QueueTimeout,
			options.CircuitFailureThreshold, options.CircuitOpenDuration),
	}, nil
}

func (c *Client) URL(path string) string {
	return strings.TrimRight(c.BaseURL.String(), "/") + "/" + strings.TrimLeft(path, "/")
}

func (c *Client) Management(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL("/v0/management/"+strings.TrimLeft(path, "/")), reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.ManagementKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.ControlHTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxControlResponseBytes))
	return resp.StatusCode, payload, err
}

// ManagementRaw intentionally does not impose a schema on CLIProxyAPI's
// management surface. CPA can add providers, plugins and protocol controls
// independently while RelayAPI remains a stable authenticated panel wrapper.
func (c *Client) ManagementRaw(ctx context.Context, method, path, contentType string, body io.Reader) (int, http.Header, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.URL("/v0/management/"+strings.TrimLeft(path, "/")), body)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.ManagementKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.ControlHTTP.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxControlResponseBytes))
	return resp.StatusCode, resp.Header.Clone(), payload, err
}

func (c *Client) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL("/v1/models"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := c.ControlHTTP.Do(req)
	if err != nil {
		c.admission.recordTransportResult(err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("CPA returned %s", resp.Status)
	}
	return nil
}

func (c *Client) Models(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL("/v1/models"), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := c.ControlHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("CPA returned %s", resp.Status)
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxControlResponseBytes)).Decode(&payload); err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(payload.Data))
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		model := strings.TrimSpace(item.ID)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	sort.Strings(models)
	return models, nil
}

func (c *Client) BridgeReady(ctx context.Context) (bool, string, error) {
	return c.bridgeReadyAtLeast(ctx, 0, 6, 0)
}

func (c *Client) QuotaReady(ctx context.Context) (bool, string, error) {
	return c.bridgeReadyAtLeast(ctx, 0, 6, 0)
}

func (c *Client) bridgeReadyAtLeast(ctx context.Context, major, minor, patch int) (bool, string, error) {
	if strings.TrimSpace(c.ManagementKey) == "" {
		return false, "", nil
	}
	status, payload, err := c.Management(ctx, http.MethodGet, "plugins", nil)
	if err != nil {
		return false, "", err
	}
	if status < 200 || status >= 300 {
		return false, "", fmt.Errorf("CPA plugins returned status %d", status)
	}
	var response struct {
		PluginsEnabled bool `json:"plugins_enabled"`
		Plugins        []struct {
			ID               string `json:"id"`
			EffectiveEnabled bool   `json:"effective_enabled"`
			Metadata         struct {
				Version string `json:"version"`
			} `json:"metadata"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return false, "", err
	}
	for _, plugin := range response.Plugins {
		if plugin.ID == "relayapi-bridge" {
			return response.PluginsEnabled && plugin.EffectiveEnabled && versionAtLeast(plugin.Metadata.Version, major, minor, patch), plugin.Metadata.Version, nil
		}
	}
	return false, "", nil
}

func versionAtLeast(value string, major, minor, patch int) bool {
	var gotMajor, gotMinor, gotPatch int
	if _, err := fmt.Sscanf(strings.TrimSpace(value), "%d.%d.%d", &gotMajor, &gotMinor, &gotPatch); err != nil {
		return false
	}
	if gotMajor != major {
		return gotMajor > major
	}
	if gotMinor != minor {
		return gotMinor > minor
	}
	return gotPatch >= patch
}
