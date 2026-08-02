package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRegistrationExposesGenericQuotaExtension(t *testing.T) {
	request, err := json.Marshal(lifecycleRequest{ConfigYAML: []byte(`
quota_adapters_mode: replace
quota_adapters:
  - id: example
    providers: [example-provider]
    requests:
      - id: usage
        url: https://example.invalid/quota
    windows:
      - kind: daily
        request: usage
        used_percent_path: used
`)})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := handle("plugin.register", request)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"management_api":true`) ||
		!strings.Contains(string(raw), `"request_interceptor":true`) ||
		!strings.Contains(string(raw), `"request_lifecycle_plugin":true`) ||
		!strings.Contains(string(raw), `"usage_plugin":false`) ||
		!strings.Contains(string(raw), `"response_interceptor":false`) ||
		!strings.Contains(string(raw), `"response_stream_interceptor":false`) ||
		!strings.Contains(string(raw), `"Version":"0.5.0"`) {
		t.Fatalf("registration = %s", raw)
	}
	loadedConfig := loaded()
	if len(loadedConfig.QuotaAdapters) != 1 || loadedConfig.QuotaAdapters[0].ID != "example" {
		t.Fatalf("loaded adapters = %+v", loadedConfig.QuotaAdapters)
	}
	routes, err := handle("management.register", nil)
	if err != nil || !strings.Contains(string(routes), `"Path":"/plugins/relayapi-bridge/quota"`) {
		t.Fatalf("management registration = %s, err = %v", routes, err)
	}
}

func TestSchedulerPinsRequestedAuthID(t *testing.T) {
	current.Store(config{Secret: "shared-secret"})
	payload := signedSchedulerPayload(t, "request-1", "auth-2", "shared-secret", []string{"auth-1", "auth-2"})
	raw, err := handle("scheduler.pick", payload)
	if err != nil {
		t.Fatal(err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || !strings.Contains(string(response.Result), `"AuthID":"auth-2"`) {
		t.Fatalf("unexpected response: %s", raw)
	}
}

func TestSchedulerRejectsUnavailableRequestedAuthID(t *testing.T) {
	current.Store(config{Secret: "shared-secret"})
	payload := signedSchedulerPayload(t, "request-2", "auth-missing", "shared-secret", []string{"auth-1"})
	if _, err := handle("scheduler.pick", payload); err == nil {
		t.Fatal("expected strict AuthID rejection")
	}
}

func TestSchedulerRejectsUnauthenticatedRoutingHeader(t *testing.T) {
	current.Store(config{Secret: "shared-secret"})
	payload := signedSchedulerPayload(t, "request-3", "auth-1", "wrong-secret", []string{"auth-1"})
	if _, err := handle("scheduler.pick", payload); err == nil {
		t.Fatal("expected unauthenticated routing request to be rejected")
	}
}

func TestRoutingSignatureExpires(t *testing.T) {
	headers := map[string][]string{
		"X-Relay-Request-ID":       {"request-4"},
		"X-Relay-Plugin-Timestamp": {strconv.FormatInt(time.Now().Add(-10*time.Minute).Unix(), 10)},
		"X-Relay-Plugin-Signature": {"00"},
	}
	if validRoutingSignature("shared-secret", headers, "auth-1", time.Now()) {
		t.Fatal("expected stale routing signature to be rejected")
	}
}

func TestLifecycleCorrelatesExecutionWithoutMutatingTraffic(t *testing.T) {
	current.Store(config{})
	request := correlationPayload{
		RequestID: "cpa-exec-1",
		Headers:   http.Header{"X-Relay-Request-ID": {"relay-request-1"}},
	}
	raw, _ := json.Marshal(request)
	response, err := handle("request.intercept_before", raw)
	if err != nil || !strings.Contains(string(response), `"ok":true`) {
		t.Fatalf("request interception response=%s err=%v", response, err)
	}
	value, ok := requestCorrelations.Load("cpa-exec-1")
	correlation, _ := value.(requestCorrelation)
	if !ok || correlation.RelayID != "relay-request-1" {
		t.Fatalf("correlation = %+v, found=%t", correlation, ok)
	}
	completion, _ := json.Marshal(completionPayload{RequestID: "cpa-exec-1", Outcome: "succeeded"})
	if _, err := handle("request.complete", completion); err != nil {
		t.Fatal(err)
	}
	if _, ok := requestCorrelations.Load("cpa-exec-1"); ok {
		t.Fatal("completion did not release request correlation")
	}
}

func TestRequestCorrelationDoesNotDecodeBody(t *testing.T) {
	current.Store(config{})
	raw := []byte(`{"RequestID":"cpa-light","Headers":{"X-Relay-Request-ID":["relay-light"]},"Body":"not-valid-base64"}`)
	if _, err := handle("request.intercept_before", raw); err != nil {
		t.Fatalf("correlation-only decode inspected Body: %v", err)
	}
	if got := takeCorrelation("cpa-light", time.Now()); got != "relay-light" {
		t.Fatalf("correlated Relay ID = %q", got)
	}
}

func TestLifecycleCompletionIsCompactAndWhitelisted(t *testing.T) {
	payload := compactCompletion(completionPayload{
		RequestID: strings.Repeat("r", 300), Error: strings.Repeat("e", 8<<10),
		Metadata: map[string]any{
			"provider": "codex", "access_token": "must-not-leak",
			"nested": map[string]any{"auth_index": "auth-1"},
		},
	})
	if len(payload.RequestID) != 256 || len(payload.Error) != 4<<10 {
		t.Fatalf("payload strings were not bounded: request=%d error=%d", len(payload.RequestID), len(payload.Error))
	}
	if payload.Metadata["provider"] != "codex" || payload.Metadata["auth_index"] != "auth-1" {
		t.Fatalf("expected metadata missing: %+v", payload.Metadata)
	}
	if _, ok := payload.Metadata["access_token"]; ok {
		t.Fatalf("secret metadata leaked: %+v", payload.Metadata)
	}
}

func TestCorrelationExpires(t *testing.T) {
	requestCorrelations.Range(func(key, _ any) bool {
		requestCorrelations.Delete(key)
		return true
	})
	correlationCount.Store(0)
	now := time.Now()
	storeCorrelation("cpa-expiring", "relay-expiring", now)
	if got := takeCorrelation("cpa-expiring", now.Add(correlationTTL+time.Second)); got != "" {
		t.Fatalf("expired correlation = %q", got)
	}
	if correlationCount.Load() != 0 {
		t.Fatalf("correlation count = %d", correlationCount.Load())
	}
}

func signedSchedulerPayload(t *testing.T, requestID, authID, secret string, candidates []string) []byte {
	t.Helper()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(requestID + "\n" + authID + "\n" + timestamp))
	rows := make([]map[string]string, 0, len(candidates))
	for _, candidate := range candidates {
		rows = append(rows, map[string]string{"ID": candidate})
	}
	payload, err := json.Marshal(map[string]any{
		"Options": map[string]any{"Headers": map[string][]string{
			"X-Relay-Request-ID":       {requestID},
			"X-Relay-CPA-Auth-ID":      {authID},
			"X-Relay-Plugin-Timestamp": {timestamp},
			"X-Relay-Plugin-Signature": {hex.EncodeToString(mac.Sum(nil))},
		}},
		"Candidates": rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestSchedulerDelegatesOnlyWithoutRequestedAuthID(t *testing.T) {
	current.Store(config{Delegate: "fill-first"})
	raw, err := handle("scheduler.pick", []byte(`{"Options":{"Headers":{}},"Candidates":[{"ID":"auth-1"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"DelegateBuiltin":"fill-first"`) {
		t.Fatalf("unexpected response: %s", raw)
	}
}
