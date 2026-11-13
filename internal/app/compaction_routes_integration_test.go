package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/gorilla/websocket"
)

func TestNativeCompactionRoutesSurvivePriorityChangesAndWebSocketContinuation(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	defer sqlDB.Close()
	tx := database.Begin()
	defer tx.Rollback()
	s, err := store.New(tx, "compaction-route-test-encryption-key")
	if err != nil {
		t.Fatal(err)
	}
	tenantID := identity.NewID()
	if err = tx.Create(&db.Tenant{ID: tenantID, Name: "compact", OwnerEmail: tenantID + "@example.test", PasswordHash: "unused", Enabled: true, BalanceNanoUSD: 1000000}).Error; err != nil {
		t.Fatal(err)
	}
	_, plain, err := s.CreateKey(t.Context(), tenantID, "test", nil, nil, []string{"model"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpsertPrice(t.Context(), store.Price{Model: "model", InputNanoUSDPerToken: 1, OutputNanoUSDPerToken: 2, PriceMultiplier: 1}); err != nil {
		t.Fatal(err)
	}
	var calls [2]atomic.Int32
	var creds []upstream.Credential
	var children []string
	var parents []string
	const seal = "account-one-opaque-compaction"
	for index := range 2 {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			respond := func(body []byte) []byte {
				n := calls[index].Add(1)
				if bytes.Contains(body, []byte(seal)) && index != 0 {
					t.Error("opaque compaction leaked to another upstream account")
				}
				item := map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "ok"}}}
				if strings.HasSuffix(r.URL.Path, "/compact") || bytes.Contains(body, []byte("compaction_trigger")) {
					item = map[string]any{"type": "compaction", "encrypted_content": seal}
				}
				response := map[string]any{"id": fmt.Sprintf("resp_%d_%d", index, n), "object": "response", "model": "model", "status": "completed", "output": []any{item}, "usage": map[string]any{"input_tokens": 10, "output_tokens": 5}}
				encoded, _ := json.Marshal(response)
				return encoded
			}
			if websocket.IsWebSocketUpgrade(r) {
				conn, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if e != nil {
					return
				}
				defer conn.Close()
				for {
					_, body, e := conn.ReadMessage()
					if e != nil {
						return
					}
					response := json.RawMessage(respond(body))
					if conn.WriteJSON(map[string]any{"type": "response.completed", "response": response}) != nil {
						return
					}
				}
			}
			body, _ := io.ReadAll(r.Body)
			encoded := respond(body)
			if bytes.Contains(body, []byte(`"stream":true`)) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":%s}\n\n", encoded)
			} else {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(encoded)
			}
		}))
		defer provider.Close()
		id := identity.NewID()
		creds = append(creds, upstream.Credential{ID: id, Provider: "codex", Enabled: true, Models: []string{"model"}, Document: mustJSON(t, map[string]any{"access_token": "fake", "type": "codex", "base_url": provider.URL, "websockets": true})})
		parent, e := s.UpsertParentSubscription(t.Context(), store.ParentSubscription{UpstreamCredentialID: id, Name: id, Provider: "codex", Enabled: true, Status: "available", CapacityMode: db.ParentCapacityUnmetered})
		if e != nil {
			t.Fatal(e)
		}
		child := db.ChildSubscription{ID: identity.NewID(), TenantID: tenantID, ParentSubscriptionID: parent.ID, Name: "test", Enabled: true, StartsAt: time.Now().Add(-time.Hour), AllocationPPM: 1000000, Priority: 10 - index}
		if e = tx.Create(&child).Error; e != nil {
			t.Fatal(e)
		}
		children = append(children, child.ID)
		parents = append(parents, parent.ID)
	}
	runtime, err := upstream.NewRuntime(upstream.Options{}, creds)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	a := &App{store: s, nativeRuntime: runtime, cfg: config.Config{MaxRequestBytes: 4 << 20, ReservationNanoUSD: 100, UpstreamWebSockets: true}, finalizationSlots: make(chan struct{}, 1)}
	a.nativeAdmission.Store(gateway.New(gateway.Options{MaxInFlight: 4}))
	request := func(path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+plain)
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		a.handlePublic(rec, r)
		a.wg.Wait()
		return rec
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/responses/compact", `{"model":"model","input":[]}`},
		{"/v1/responses", `{"model":"model","stream":true,"input":[{"type":"compaction_trigger"}]}`},
	} {
		rec := request(tc.path, tc.body)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), seal) {
			t.Fatalf("compact: %d %s", rec.Code, rec.Body)
		}
	}
	if err = tx.Model(&db.ChildSubscription{}).Where("id = ?", children[1]).Update("priority", 100).Error; err != nil {
		t.Fatal(err)
	}
	body := `{"model":"model","input":[{"type":"compaction","encrypted_content":"` + seal + `"},{"role":"user","content":"continue"}]}`
	rec := request("/v1/responses", body)
	if rec.Code != 200 || calls[0].Load() != 3 || calls[1].Load() != 0 {
		t.Fatalf("priority moved the compacted thread: %d %s %d/%d", rec.Code, rec.Body, calls[0].Load(), calls[1].Load())
	}
	wsDone := make(chan struct{})
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.handlePublic(w, r); close(wsDone) }))
	defer relay.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(relay.URL, "http")+"/v1/responses", http.Header{"Authorization": []string{"Bearer " + plain}})
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for _, frame := range []string{strings.Replace(body, `{"model"`, `{"type":"response.create","model"`, 1), `{"type":"response.create","previous_response_id":"resp_0_4","input":[{"role":"user","content":"again"}]}`} {
		if err = conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
			t.Fatal(err)
		}
		_, payload, e := conn.ReadMessage()
		if e != nil || !bytes.Contains(payload, []byte("response.completed")) {
			t.Fatalf("WS continuation: %s %v", payload, e)
		}
	}
	if err = tx.Model(&db.APIKey{}).Where("tenant_id = ?", tenantID).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","input":[]}`)); err != nil {
		t.Fatal(err)
	}
	_, revoked, e := conn.ReadMessage()
	if !websocket.IsCloseError(e, websocket.ClosePolicyViolation) && (e != nil || !bytes.Contains(revoked, []byte("invalid_api_key"))) {
		t.Fatalf("revoked key kept generating: %s %v", revoked, e)
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	_ = conn.Close()
	select {
	case <-wsDone:
	case <-time.After(5 * time.Second):
		t.Fatal("WebSocket did not finish settlement")
	}
	relay.Close()
	a.wg.Wait()
	if err = tx.Model(&db.APIKey{}).Where("tenant_id = ?", tenantID).Update("enabled", true).Error; err != nil {
		t.Fatal(err)
	}
	if calls[0].Load() != 5 || calls[1].Load() != 0 {
		t.Fatalf("WS lost account binding: %d/%d", calls[0].Load(), calls[1].Load())
	}
	if err = tx.Model(&db.ParentSubscription{}).Where("id = ?", parents[0]).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	rec = request("/v1/responses", body)
	if rec.Code != 409 || calls[1].Load() != 0 {
		t.Fatalf("unavailable compaction silently failed over: %d %s", rec.Code, rec.Body)
	}
	if _, err = s.CompactionCredential(t.Context(), identity.NewID(), compactionHashes([]byte(body), true)); err != store.ErrCompactionContext {
		t.Fatalf("cross-tenant seal accepted: %v", err)
	}
	if err = tx.Model(&db.CompactionRoute{}).Where("tenant_id = ?", tenantID).Update("expires_at", time.Now().Add(-time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	rec = request("/v1/responses", body)
	if rec.Code != 400 {
		t.Fatalf("expired seal accepted: %d %s", rec.Code, rec.Body)
	}
}
