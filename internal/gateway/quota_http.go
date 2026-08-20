package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

func requestQuotaJSON(ctx context.Context, client *http.Client, endpoint string, headers http.Header) (map[string]any, error) {
	_, payload, err := requestQuotaHTTP(ctx, client, endpoint, headers)
	return payload, err
}

func requestQuotaHTTP(ctx context.Context, client *http.Client, endpoint string, headers http.Header) (int, map[string]any, error) {
	if client == nil {
		client = http.DefaultClient
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header = headers.Clone()
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, maxQuotaResponseBytes))
	if err != nil {
		return response.StatusCode, nil, err
	}
	payload := decodeQuotaObject(body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, payload, fmt.Errorf("upstream returned HTTP %d: %s", response.StatusCode, truncateQuotaError(string(body)))
	}
	if payload == nil {
		return response.StatusCode, nil, fmt.Errorf("decode upstream JSON: empty or invalid object")
	}
	return response.StatusCode, payload, nil
}

func decodeQuotaObject(body []byte) map[string]any {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return nil
	}
	return payload
}

func truncateQuotaError(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "empty response"
	}
	if utf8.RuneCountInString(trimmed) <= 240 {
		return trimmed
	}
	return string([]rune(trimmed)[:240]) + "…"
}
