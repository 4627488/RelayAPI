package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v8/relaybridge"
)

func TestEmbeddedCPASyntheticPrewarmHasCompleteZeroSettlement(t *testing.T) {
	runtime, err := relaybridge.NewRuntime(relaybridge.Options{APIKey: "internal-test"}, []relaybridge.Credential{{
		ID: "prewarm-compat", Provider: "openai", Enabled: true, Models: []string{"relay-prewarm-test"},
		Document: []byte(`{"type":"openai","api_key":"unused","base_url":"https://example.invalid/v1"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	server := httptest.NewServer(runtime.Handler())
	defer server.Close()
	client, err := cpa.New(server.URL, "internal-test", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	app := &App{nativeCPA: client, nativeCPARuntime: runtime, cfg: config.Config{MaxRequestBytes: 1 << 20}}
	app.nativeRuntime = &embeddedCPAAdapter{app: app}
	turns := make(chan nativeWebSocketBillingEntry, 1)
	finished := make(chan struct{})
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		accounting := &nativeWebSocketAccounting{billable: true, admission: store.Admission{UpstreamCredentialID: "prewarm-compat", QuotaReservedNanoUSD: 10_000_000}}
		accounting.persistTurn = func(entry nativeWebSocketBillingEntry, _ billing.Result) (bool, error) {
			turns <- entry
			return true, nil
		}
		_, _, _ = app.serveNativeWebSocket(w, r, store.KeyContext{}, requestMeta{}, "synthetic-prewarm", nil, accounting)
	}))
	defer downstream.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+downstream.URL[len("http"):]+"/v1/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"relay-prewarm-test","generate":false,"service_tier":"priority","input":[]}`)); err != nil {
		t.Fatal(err)
	}
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if isNativeWebSocketUsageTerminalEvent(payload) {
			break
		}
	}
	entry := <-turns
	assessment := billing.Assess(entry.Result, nil, 10_000_000)
	if !entry.Meta.Prewarm || !entry.Result.NonGenerated() || !assessment.Complete || assessment.CostNanoUSD != 0 {
		t.Fatalf("synthetic prewarm charged or classified as missing: %+v / %+v", entry.Result, assessment)
	}
	next := &nativeWebSocketAccounting{currentMeta: entry.Meta}
	_, followup, _, err := app.prepareNativeWebSocketRequest([]byte(`{"type":"response.create","model":"relay-prewarm-test","input":[]}`), nil, store.KeyContext{}, next)
	if err != nil || followup.Prewarm {
		t.Fatalf("generation inherited prewarm: %+v / %v", followup, err)
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("prewarm socket did not close")
	}
}

func TestEmbeddedCPARefreshCredentialReturnsLiveDocument(t *testing.T) {
	runtime, err := relaybridge.NewRuntime(relaybridge.Options{APIKey: "test-key"}, []relaybridge.Credential{{
		ID: "kimi-live", Provider: "kimi", Enabled: true, Models: []string{"kimi-k2.5"},
		Document: mustJSON(t, map[string]any{"type": "kimi", "access_token": "live-access", "refresh_token": "refresh", "expired": time.Now().Add(time.Hour).Format(time.RFC3339)}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })
	application := &App{nativeCPARuntime: runtime}
	application.nativeRuntime = &embeddedCPAAdapter{app: application}
	document := application.refreshQuotaCredentialDocument(t.Context(), "kimi-live", []byte(`{"access_token":"stale-database-token"}`), false)
	var value map[string]any
	if json.Unmarshal(document, &value) != nil || value["access_token"] != "live-access" {
		t.Fatal("quota probe did not receive CPA's live token")
	}
	if _, _, err = application.nativeRuntime.RefreshCredential(t.Context(), "missing", true); err == nil {
		t.Fatal("missing credential accepted")
	}
	var unavailable *embeddedCPAAdapter
	if _, _, err = unavailable.RefreshCredential(t.Context(), "kimi-live", false); err == nil {
		t.Fatal("missing runtime accepted")
	}
}

func TestSameModelSetIgnoresOrderAndCase(t *testing.T) {
	if !sameModelSet([]string{"gpt-6-astra", "gpt-5.6-sol"}, []string{"GPT-5.6-sol", "gpt-6-astra"}) {
		t.Fatal("expected equal model sets")
	}
	if sameModelSet([]string{"gpt-6-astra"}, []string{"gpt-6-astra", "gpt-5.6-sol"}) {
		t.Fatal("expected unequal model sets")
	}
}

func TestToBridgeCredentialsCopiesDocuments(t *testing.T) {
	original := []byte(`{"type":"codex","access_token":"secret"}`)
	credentials := toBridgeCredentials([]upstream.Credential{{
		ID: "codex-1", Label: "Codex", Provider: "codex", Enabled: true,
		Models: []string{"gpt-5"}, Document: original,
	}})
	if len(credentials) != 1 || credentials[0].ID != "codex-1" || credentials[0].Provider != "codex" {
		t.Fatalf("credentials = %#v", credentials)
	}
	credentials[0].Document[0] = 'X'
	if string(original) == string(credentials[0].Document) {
		t.Fatal("bridge credential aliased the stored document")
	}
}

func TestConvertCPATraceKeepsAttemptTimes(t *testing.T) {
	started := time.Date(2026, 8, 20, 8, 0, 0, 0, time.UTC)
	trace := convertCPATrace(relaybridge.RequestTrace{
		RequestID: "req-1", StartedAt: started, CompletedAt: started.Add(2 * time.Second),
		Attempts: []relaybridge.ExecutionAttempt{{
			Number: 1, Provider: "codex", Model: "gpt-5", CredentialID: "cred-1",
			StartedAt: started, FirstChunkAt: started.Add(200 * time.Millisecond),
			CompletedAt: started.Add(2 * time.Second), Status: "ok",
		}},
	})
	if trace.RequestID != "req-1" || len(trace.Attempts) != 1 {
		t.Fatalf("trace = %#v", trace)
	}
	if !trace.Attempts[0].FirstResponseAt.IsZero() {
		t.Fatalf("first response = %s", trace.Attempts[0].FirstResponseAt)
	}
	if trace.Attempts[0].CredentialID != "cred-1" || trace.Attempts[0].Provider != "codex" {
		t.Fatalf("attempt = %#v", trace.Attempts[0])
	}
}

func TestRuntimeBridgeSettingsMapsImageAndCooling(t *testing.T) {
	settings := defaultNativeRuntimeSettings()
	settings.ImageGenerationMode = "disabled"
	settings.DisableCredentialCooling = true
	compiled := runtimeBridgeSettings(settings, "")
	if compiled.DisableImageGeneration != "all" {
		t.Fatalf("image mode = %q", compiled.DisableImageGeneration)
	}
	if compiled.ProxyURL != "direct" || !compiled.DisableCredentialCooling || compiled.RequestRetry != 2 {
		t.Fatalf("bridge settings = %#v", compiled)
	}
}
