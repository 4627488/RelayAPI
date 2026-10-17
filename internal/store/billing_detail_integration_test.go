package store

import (
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestBillingDetailAtomicityAndUnchargedOutcomes(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := database.DB()
	defer conn.Close()
	dataStore := Store{DB: database}
	tenantID, keyID := identity.NewID(), identity.NewID()
	if err := database.Create(&db.Tenant{ID: tenantID, Name: "billing", OwnerEmail: tenantID + "@example.test", PasswordHash: "test", Enabled: true, BalanceNanoUSD: 1000}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&db.APIKey{ID: keyID, TenantID: tenantID, Name: "billing", KeyHash: []byte(keyID), Prefix: "test", Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	admit := func() string {
		t.Helper()
		id := identity.NewID()
		_, err := dataStore.AdmitRequest(t.Context(), AdmissionInput{RequestID: id, Key: KeyContext{APIKey: db.APIKey{ID: keyID, TenantID: tenantID}}, Model: "test", BalanceReserve: 10, PriceConfigured: true, ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	assertBalance := func(want int64) {
		t.Helper()
		var tenant db.Tenant
		if err := database.First(&tenant, "id = ?", tenantID).Error; err != nil || tenant.BalanceNanoUSD != want {
			t.Fatalf("balance=%d want=%d err=%v", tenant.BalanceNanoUSD, want, err)
		}
	}
	assertBills := func(id string, want int64) {
		t.Helper()
		var n int64
		if err := database.Model(&db.RequestLog{}).Where("id = ? OR reservation_request_id = ?", id, id).Count(&n).Error; err != nil || n != want {
			t.Fatalf("bills=%d want=%d err=%v", n, want, err)
		}
	}
	paid := LogInput{TenantID: tenantID, APIKeyID: keyID, Model: "test", Usage: Usage{Prompt: 10, Total: 10}, CostNanoUSD: int64Pointer(25), PricingComplete: true, Settled: true, Method: "POST", Path: "/v1/responses", StartedAt: time.Now(), CompletedAt: time.Now()}
	id := admit()
	broken := paid
	// Force the detail INSERT to fail after settlement and the summary INSERT.
	broken.Detail = &LogDetailInput{RequestBody: "\x00"}
	if err := dataStore.SettleRequestWithLog(t.Context(), id, broken); err == nil {
		t.Fatal("invalid detail unexpectedly committed")
	}
	assertBalance(990)
	assertBills(id, 0)
	var reservation RequestReservation
	if err := database.First(&reservation, "request_id = ?", id).Error; err != nil || reservation.Status != db.ReservationActive {
		t.Fatalf("failed settlement changed reservation: %+v err=%v", reservation, err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Go(func() { errs <- dataStore.SettleRequestWithLog(t.Context(), id, paid) })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	assertBalance(975)
	assertBills(id, 1)
	for _, item := range []LogInput{
		{PricingComplete: false, CostNanoUSD: int64Pointer(25)},
		{PricingComplete: true, CostNanoUSD: int64Pointer(0)},
		{PricingComplete: false},
		{LogUnit: LogUnitPrewarm, PricingComplete: true, CostNanoUSD: int64Pointer(0)},
	} {
		id := admit()
		if err := dataStore.SettleRequestWithLog(t.Context(), id, item); err != nil {
			t.Fatal(err)
		}
		assertBalance(975)
		assertBills(id, 0)
	}
	id = admit()
	turn := WebSocketTurnAccrual{RequestID: id, TurnID: "response", Model: "test", Usage: paid.Usage, CostNanoUSD: 25, PricingComplete: true, Log: broken}
	if _, err := dataStore.AccrueWebSocketTurn(t.Context(), turn); err == nil {
		t.Fatal("invalid websocket detail unexpectedly committed")
	}
	assertBalance(965)
	assertBills(id, 0)
	turn.Log = paid
	if inserted, err := dataStore.AccrueWebSocketTurn(t.Context(), turn); err != nil || !inserted {
		t.Fatalf("retry inserted=%v err=%v", inserted, err)
	}
	if inserted, err := dataStore.AccrueWebSocketTurn(t.Context(), turn); err != nil || inserted {
		t.Fatalf("duplicate inserted=%v err=%v", inserted, err)
	}
	turn.TurnID, turn.CostNanoUSD, turn.PricingComplete = "unknown", 0, false
	if _, err := dataStore.AccrueWebSocketTurn(t.Context(), turn); err != nil {
		t.Fatal(err)
	}
	if err := dataStore.SettleRequestReservation(t.Context(), id, 25, true); err != nil {
		t.Fatal(err)
	}
	assertBalance(950)
	assertBills(id, 1)
	detail, err := dataStore.RequestLogDetail(t.Context(), WebSocketStepID(id, "response"), tenantID)
	if err != nil || detail.Log.BillingSource != "balance" || detail.Log.ReservedNanoUSD != 0 {
		t.Fatalf("websocket bill=%+v err=%v", detail.Log, err)
	}
	raw, _ := json.Marshal(detail)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if _, nested := fields["turns"]; nested {
		t.Fatal("billing detail contains nested charges")
	}
}

func TestReservationFundingSourceIsImmutable(t *testing.T) {
	// Funding is determined entirely by the admission record, so even a removed
	// or edited parent cannot redirect a later settlement.
	for _, tc := range []struct {
		quota int64
		want  string
	}{{0, "balance"}, {10, "subscription"}} {
		reservation := RequestReservation{QuotaReservedNanoUSD: tc.quota}
		usesBalance, err := reservationUsesBalance(nil, reservation)
		if err != nil || usesBalance != (tc.want == "balance") || reservationBillingSource(reservation) != tc.want {
			t.Fatalf("reservation=%+v balance=%v err=%v", reservation, usesBalance, err)
		}
	}
}
