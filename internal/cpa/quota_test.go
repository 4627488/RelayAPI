package cpa

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestQuotaReadsNormalizedBridgeReport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/plugins/relayapi-bridge/quota" || r.URL.Query().Get("auth_index") != "index/one" {
			t.Fatalf("unexpected request URL %s", r.URL.String())
		}
		if r.Header.Get("Authorization") != "Bearer management-secret" {
			t.Fatal("missing management authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"auth_index":"index/one","provider":"codex","supported":true,"observed_at":"2026-07-29T10:00:00Z","windows":[{"kind":"5h","used_percent":25,"resets_at":"2026-07-29T15:00:00Z","enforceable":true}]}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "api", "management-secret", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	report, err := client.Quota(context.Background(), "index/one")
	if err != nil {
		t.Fatal(err)
	}
	if !report.Supported || report.Provider != "codex" || len(report.Windows) != 1 || report.Windows[0].UsedPercent == nil {
		t.Fatalf("report = %+v", report)
	}
}

func TestQuotaRejectsMismatchedAuthIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"auth_index":"other","provider":"codex","supported":true,"observed_at":"2026-07-29T10:00:00Z","windows":[]}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "api", "management-secret", time.Second)
	if _, err := client.Quota(context.Background(), "wanted"); err == nil {
		t.Fatal("expected auth index mismatch")
	}
}
