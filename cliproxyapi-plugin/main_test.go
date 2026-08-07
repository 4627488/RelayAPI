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
		!strings.Contains(string(raw), `"request_interceptor":false`) ||
		!strings.Contains(string(raw), `"request_lifecycle_plugin":false`) ||
		!strings.Contains(string(raw), `"usage_plugin":false`) ||
		!strings.Contains(string(raw), `"response_interceptor":false`) ||
		!strings.Contains(string(raw), `"response_stream_interceptor":false`) ||
		!strings.Contains(string(raw), `"Version":"0.6.0"`) {
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

func TestManagementHealthAcceptsFullCPAPath(t *testing.T) {
	payload, err := json.Marshal(managementRequest{Method: http.MethodGet, Path: "/v0/management/plugins/relayapi-bridge/health"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := handle("management.handle", payload)
	if err != nil {
		t.Fatal(err)
	}
	var wrapped envelope
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		t.Fatal(err)
	}
	var response managementResponse
	if err := json.Unmarshal(wrapped.Result, &response); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response.Body), `"mode":"control-plane-only"`) ||
		!strings.Contains(string(response.Body), `"data_plane_interceptors":false`) ||
		!strings.Contains(string(response.Body), `"status":"ok"`) {
		t.Fatalf("health response = %s", response.Body)
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
