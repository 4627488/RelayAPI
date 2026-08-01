package cpa

import (
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestModelsReturnsSortedUniqueCPAModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer api-secret" {
			t.Fatal("missing API authorization")
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"model-b"},{"id":" model-a "},{"id":"model-b"},{"id":""}]}`)
	}))
	defer server.Close()
	client, err := New(server.URL, "api-secret", "management-secret", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	models, err := client.Models(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"model-a", "model-b"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

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
