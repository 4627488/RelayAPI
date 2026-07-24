package cpa

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	BaseURL       *url.URL
	APIKey        string
	ManagementKey string
	HTTP          *http.Client
}

func New(rawURL, apiKey, managementKey string, timeout time.Duration) (*Client, error) {
	base, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	return &Client{
		BaseURL: base, APIKey: apiKey, ManagementKey: managementKey,
		HTTP: &http.Client{Timeout: timeout},
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
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return resp.StatusCode, payload, err
}

func (c *Client) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL("/v1/models"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("CPA returned %s", resp.Status)
	}
	return nil
}
