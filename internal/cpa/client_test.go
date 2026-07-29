package cpa

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestVersionAtLeast(t *testing.T) {
	if !versionAtLeast("0.2.0", 0, 2, 0) || !versionAtLeast("1.0.0", 0, 2, 0) {
		t.Fatal("expected compatible bridge versions")
	}
	if versionAtLeast("0.1.9", 0, 2, 0) || versionAtLeast("invalid", 0, 2, 0) {
		t.Fatal("expected incompatible bridge version")
	}
}

func TestQuotaReadyRequiresBridgeVersionThree(t *testing.T) {
	version := "0.2.9"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/plugins" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"plugins_enabled":true,"plugins":[{"id":"relayapi-bridge","effective_enabled":true,"metadata":{"version":"` + version + `"}}]}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "api", "management", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ready, gotVersion, err := client.QuotaReady(t.Context())
	if err != nil || ready || gotVersion != version {
		t.Fatalf("quota ready/version/error = %v/%q/%v", ready, gotVersion, err)
	}
	version = "0.3.0"
	ready, gotVersion, err = client.QuotaReady(t.Context())
	if err != nil || !ready || gotVersion != version {
		t.Fatalf("quota ready/version/error = %v/%q/%v", ready, gotVersion, err)
	}
}
