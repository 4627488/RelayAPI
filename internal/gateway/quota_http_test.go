package gateway

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestQuotaRetryAfter(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, tc := range []struct {
		value string
		want  time.Time
	}{
		{"120", now.Add(120 * time.Second)},
		{now.Add(time.Hour).Format(http.TimeFormat), now.Add(time.Hour)},
		{"", time.Time{}}, {"-1", time.Time{}}, {"0", time.Time{}},
		{"9223372036854775807", time.Time{}},
		{now.Add(-time.Hour).Format(http.TimeFormat), time.Time{}},
	} {
		if got := quotaRetryAt(tc.value, now); !got.Equal(tc.want) {
			t.Fatalf("Retry-After %q: %v, want %v", tc.value, got, tc.want)
		}
	}
}

func TestQuota429PreservesRetryMetadataAndStopsFallbacks(t *testing.T) {
	for _, provider := range []string{"claude", "codex", "kimi", "xai"} {
		t.Run(provider, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Retry-After", "120")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"rate limited"}`))
			}))
			defer server.Close()
			before := time.Now()
			_, err := probeQuotaWithClient(t.Context(), server.Client(), quotaEndpoints{
				claudeUsage: server.URL, codexUsage: server.URL,
				kimiUsage: server.URL, kimiUsageFallback: server.URL,
				xaiCredits: server.URL, xaiBilling: server.URL, xaiSettings: server.URL,
			}, "credential", provider, map[string]any{"access_token": "token", "account_id": "account"}, before)
			var upstream *QuotaHTTPError
			if !errors.As(err, &upstream) || upstream.StatusCode != 429 || upstream.RetryAt.Before(before.Add(120*time.Second)) {
				t.Fatalf("missing rate limit metadata: %v", err)
			}
			if calls != 1 {
				t.Fatalf("made %d requests after rate limit", calls)
			}
		})
	}
}
