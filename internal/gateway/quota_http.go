package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// QuotaHTTPError retains rate-limit metadata through provider error wrapping.
type QuotaHTTPError struct {
	StatusCode int
	RetryAt    time.Time
	Message    string
}

func (e *QuotaHTTPError) Error() string {
	return fmt.Sprintf("upstream returned HTTP %d: %s", e.StatusCode, e.Message)
}

func quotaRetryAt(value string, now time.Time) time.Time {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		// Avoid overflow on an invalid or malicious delta-seconds value.
		if seconds > 0 && seconds <= int64((1<<63-1)/int64(time.Second)) {
			return now.Add(time.Duration(seconds) * time.Second)
		}
		return time.Time{}
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at
	}
	return time.Time{}
}

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
		return response.StatusCode, payload, &QuotaHTTPError{
			StatusCode: response.StatusCode,
			RetryAt:    quotaRetryAt(response.Header.Get("Retry-After"), time.Now()),
			Message:    truncateQuotaError(string(body)),
		}
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
