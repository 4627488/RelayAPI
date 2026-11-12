package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

type finalizerBoundaryRuntime struct {
	upstream.Runtime
	cancel context.CancelFunc
}

func (r finalizerBoundaryRuntime) Serve(w http.ResponseWriter, _ *http.Request, _ []byte) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"model":"finalizer-model","usage":{"input_tokens":10,"output_tokens":5}}`))
	if r.cancel != nil {
		r.cancel()
	}
}
func (finalizerBoundaryRuntime) TakeRequestTrace(string) (upstream.RequestTrace, bool) {
	return upstream.RequestTrace{}, false
}

func TestDeferredFinalizerUsesResponseBoundaryCancellation(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := database.DB()
	defer conn.Close()
	for _, cancelBeforeReturn := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal handler teardown", true: "actual client cancellation"}[cancelBeforeReturn], func(t *testing.T) {
			tx := database.Begin()
			defer tx.Rollback()
			dataStore, err := store.New(tx, "finalizer-test-key-at-least-thirty-two-bytes")
			if err != nil {
				t.Fatal(err)
			}
			tenant, key, id := identity.NewID(), identity.NewID(), identity.NewID()
			if err := tx.Create(&db.Tenant{ID: tenant, Name: "finalizer", OwnerEmail: tenant + "@example.test", PasswordHash: "test", Enabled: true, BalanceNanoUSD: 1000}).Error; err != nil {
				t.Fatal(err)
			}
			apiKey := db.APIKey{ID: key, TenantID: tenant, Name: "test", KeyHash: []byte(key), Prefix: "test", Enabled: true}
			if err := tx.Create(&apiKey).Error; err != nil {
				t.Fatal(err)
			}
			if err := dataStore.UpsertPrice(t.Context(), store.Price{Model: "finalizer-model", InputNanoUSDPerToken: 2, OutputNanoUSDPerToken: 3, PriceMultiplier: 1}); err != nil {
				t.Fatal(err)
			}
			principal := store.KeyContext{APIKey: apiKey}
			admission, err := dataStore.AdmitRequest(t.Context(), store.AdmissionInput{RequestID: id, Key: principal, Model: "finalizer-model", BalanceReserve: 10, PriceConfigured: true, ExpiresAt: time.Now().Add(time.Hour)})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime := finalizerBoundaryRuntime{}
			if cancelBeforeReturn {
				runtime.cancel = cancel
			}
			a := App{store: dataStore, nativeRuntime: runtime, finalizationSlots: make(chan struct{}, 1)}
			deferred := make(chan priceLookupResult)
			started := time.Now()
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(ctx)
			a.serveInference(httptest.NewRecorder(), req, publicInference{key: principal, requestID: id, admission: admission, meta: requestMeta{Model: "finalizer-model"}, started: started, timeline: newLatencyTimeline(started), billable: true, priceConfigured: true, deferredAdmissionPrice: deferred, targetAdmission: gateway.New(gateway.Options{MaxInFlight: 1})})
			// This is what net/http does when a successful handler returns. Keep the
			// finalizer blocked until after teardown to reproduce the production race.
			cancel()
			deferred <- priceLookupResult{price: store.ResolvedPrice{Price: pricing.Price{Model: "finalizer-model", InputNanoUSDPerToken: 2, OutputNanoUSDPerToken: 3, PriceMultiplier: 1}}}
			a.wg.Wait()
			var got db.RequestLog
			if err := tx.First(&got, "id = ?", id).Error; err != nil {
				t.Fatal(err)
			}
			want := 200
			if cancelBeforeReturn {
				want = 499
			}
			if got.StatusCode != want || got.Canceled != cancelBeforeReturn || got.CostNanoUSD == nil || *got.CostNanoUSD != 35 {
				t.Fatalf("wrong completion result: %+v", got)
			}
		})
	}
}
