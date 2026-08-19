package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestChooseProbeModel(t *testing.T) {
	t.Parallel()
	published := []string{"gpt-public", "gpt-mini"}
	for _, test := range []struct {
		requested string
		want      string
		wantErr   bool
	}{
		{requested: "", want: "gpt-public"},
		{requested: "gpt-mini", want: "gpt-mini"},
		{requested: "GPT-PUBLIC", want: "gpt-public"},
		{requested: "missing", wantErr: true},
	} {
		got, err := chooseProbeModel(test.requested, published)
		if test.wantErr {
			if err == nil {
				t.Fatalf("chooseProbeModel(%q) accepted unknown model", test.requested)
			}
			continue
		}
		if err != nil || got != test.want {
			t.Fatalf("chooseProbeModel(%q) = %q, %v, want %q", test.requested, got, err, test.want)
		}
	}
	if _, err := chooseProbeModel("", nil); err == nil {
		t.Fatal("empty catalog was accepted")
	}
}

func TestProbePreviewExtractsChatAndErrorText(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		payload string
		want    string
	}{
		{payload: `{"choices":[{"message":{"content":"pong"}}]}`, want: "pong"},
		{payload: `{"output_text":"ok"}`, want: "ok"},
		{payload: `{"choices":[{"message":{"content":[{"text":"hello"},{"text":" world"}]}}]}`, want: "hello world"},
		{payload: `{"error":{"message":"quota exceeded"}}`, want: "quota exceeded"},
		{payload: "not-json", want: "not-json"},
	} {
		if got := probePreview([]byte(test.payload)); got != test.want {
			t.Fatalf("probePreview(%s) = %q, want %q", test.payload, got, test.want)
		}
	}
}

func TestProbeNativeAccountPinsCredentialAndReportsSuccess(t *testing.T) {
	var seen []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen = append(seen, r.URL.Path+" "+string(body))
		if !strings.Contains(string(body), `"model":"gpt-public"`) {
			http.Error(w, `{"error":{"message":"wrong model"}}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"pong"}}]}`)
	}))
	t.Cleanup(provider.Close)

	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{
		{
			ID: "other", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
			Document: json.RawMessage(`{"type":"openai","api_key":"other-key","base_url":"` + provider.URL + `"}`),
		},
		{
			ID: "target", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
			Document: json.RawMessage(`{"type":"openai","api_key":"target-key","base_url":"` + provider.URL + `"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	result := probeNativeAccount(t.Context(), runtime, store.UpstreamCredentialSnapshot{
		ID: "target", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
	}, "gpt-public")
	if !result.OK || result.StatusCode != http.StatusOK || result.Preview != "pong" || result.Model != "gpt-public" {
		t.Fatalf("probe result = %+v", result)
	}
	if result.LatencyMS < 0 {
		t.Fatalf("latency = %d", result.LatencyMS)
	}
	if len(seen) != 1 || !strings.Contains(seen[0], "/chat/completions") {
		t.Fatalf("upstream calls = %#v", seen)
	}
}

func TestProbeNativeAccountReturnsProviderError(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	t.Cleanup(provider.Close)

	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{{
		ID: "openai-1", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
		Document: json.RawMessage(`{"type":"openai","api_key":"key","base_url":"` + provider.URL + `"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	result := probeNativeAccount(t.Context(), runtime, store.UpstreamCredentialSnapshot{
		ID: "openai-1", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
	}, "gpt-public")
	if result.OK || result.StatusCode != http.StatusTooManyRequests || result.Error != "rate limited" {
		t.Fatalf("probe result = %+v", result)
	}
}

func TestProbeNativeAccountPinsAwayFromOtherCredential(t *testing.T) {
	var hitOther, hitTarget int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitOther++
		http.Error(w, "wrong credential", http.StatusForbidden)
	}))
	t.Cleanup(other.Close)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitTarget++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"pong"}}]}`)
	}))
	t.Cleanup(target.Close)

	runtime, err := upstream.NewRuntime(upstream.Options{}, []upstream.Credential{
		{
			ID: "other", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
			Document: json.RawMessage(`{"type":"openai","api_key":"other","base_url":"` + other.URL + `"}`),
		},
		{
			ID: "target", Provider: "openai", Enabled: true, Models: []string{"gpt-public"},
			Document: json.RawMessage(`{"type":"openai","api_key":"target","base_url":"` + target.URL + `"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	result := probeNativeAccount(t.Context(), runtime, store.UpstreamCredentialSnapshot{
		ID: "target", Provider: "openai",
	}, "gpt-public")
	if !result.OK || hitTarget != 1 || hitOther != 0 {
		t.Fatalf("result=%+v hitTarget=%d hitOther=%d", result, hitTarget, hitOther)
	}
}
