package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
	"github.com/lib/pq"
)

func TestMagpieUsageHTTPAuthScopeAndLiveQuota(t *testing.T) {
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
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	s, err := store.New(tx, "sub2api-test-encryption-key-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	tenantID, parentID, childID := identity.NewID(), identity.NewID(), identity.NewID()
	now := time.Now().UTC().Truncate(time.Second)
	for _, row := range []any{
		&db.Tenant{ID: tenantID, Name: "usage", OwnerEmail: tenantID + "@example.test", PasswordHash: "unused", Enabled: true, BalanceNanoUSD: 42e9},
		&db.ParentSubscription{ID: parentID, Name: "private-upstream@example.test", UpstreamCredentialID: "private-credential", CapacityMode: db.ParentCapacityObserved, Enabled: true, Status: "available", AllocationLimitPPM: 1000000},
		&db.ChildSubscription{ID: childID, TenantID: tenantID, ParentSubscriptionID: parentID, Name: "Codex plan", ModelAllowlist: []string{"codex"}, Enabled: true, StartsAt: now.Add(-time.Hour), AllocationPPM: 100000},
		&db.ParentQuotaWindow{ParentSubscriptionID: parentID, Kind: "5h", LimitNanoUSD: 1000e9, ResetsAt: now.Add(time.Hour)},
		&db.ChildQuotaWindow{ChildSubscriptionID: childID, Kind: "5h", LimitNanoUSD: 100e9, SettledNanoUSD: 20e9, ReservedNanoUSD: 5e9, StartedAt: now.Add(-time.Hour), ResetsAt: now.Add(time.Hour)},
	} {
		if err := tx.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	key, plain, err := s.CreateKey(t.Context(), tenantID, "laptop", nil, nil, []string{"codex"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	otherTenantID := identity.NewID()
	if err := tx.Create(&db.Tenant{ID: otherTenantID, Name: "other", OwnerEmail: otherTenantID + "@example.test", PasswordHash: "unused", Enabled: true, BalanceNanoUSD: 7e9}).Error; err != nil {
		t.Fatal(err)
	}
	_, otherPlain, err := s.CreateKey(t.Context(), otherTenantID, "other", nil, nil, []string{"codex"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{"codex", "other-model"}, Document: []byte(`{"type":"codex","access_token":"fake"}`)})
	a.store = s
	a.cfg.PublicURL = "https://relay.example"
	a.mux = http.NewServeMux()
	a.routes()
	get := func(path, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		a.mux.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("sensitive usage response is cacheable")
		}
		return rec
	}
	read := func(path, token string) magpieUsageDocument {
		t.Helper()
		rec := get(path, token)
		var doc magpieUsageDocument
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &doc) != nil {
			t.Fatalf("usage: %d %s", rec.Code, rec.Body)
		}
		for _, secret := range []string{parentID, "private-upstream", "private-credential", plain} {
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("usage leaks upstream or key: %s", secret)
			}
		}
		return doc
	}
	for _, token := range []string{"", "invalid"} {
		if rec := get("/v1/usage", token); rec.Code != 401 {
			t.Fatalf("unauthenticated query: %d", rec.Code)
		}
	}
	doc := read("/v1/usage", plain)
	if doc.QuotaMapping != "native" || len(doc.RateLimits) != 1 || doc.RateLimits[0].Limit != 100 || doc.RateLimits[0].Used != 25 || doc.BalanceUSD != 42 || doc.Remaining != nil {
		t.Fatalf("usage: %+v", doc)
	}
	legacy := read("/api/magpie/balance", plain)
	if legacy.SubscriptionSummary != doc.SubscriptionSummary || legacy.BalanceUSD != doc.BalanceUSD {
		t.Fatal("legacy balance path drifted")
	}
	other := read("/v1/usage", otherPlain)
	if len(other.Grants) != 0 || len(other.RateLimits) != 0 || other.Remaining == nil || *other.Remaining != 7 {
		t.Fatalf("tenant scope leaked: %+v", other)
	}
	// Import uses the standard path, and its supported CLI settings classify the
	// actual model entitlement, without putting key material in shell history.
	req := httptest.NewRequest("GET", "/api/keys/"+key.ID+"/magpie", nil)
	req.SetPathValue("id", key.ID)
	rec := httptest.NewRecorder()
	a.magpieImport(rec, req.WithContext(context.WithValue(req.Context(), sessionKey, identity.Session{TenantID: tenantID})))
	var imported struct {
		Href             string
		ConfigureCommand string `json:"configure_command"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &imported) != nil || !strings.HasSuffix(imported.ConfigureCommand, " billing=plan") || strings.Contains(imported.ConfigureCommand, plain) {
		t.Fatalf("import: %d %s", rec.Code, rec.Body)
	}
	link, _ := url.Parse(imported.Href)
	params, _ := url.ParseQuery(link.Fragment)
	if params.Get("balance") != "https://relay.example/v1/usage" {
		t.Fatal("import bypasses native quota reader")
	}
	// A parent reset makes a never-used generation available immediately; the
	// previous generation's settled spend and reservations must not carry over.
	if err := tx.Model(&db.ParentQuotaWindow{}).Where("parent_subscription_id = ?", parentID).Update("resets_at", now.Add(2*time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	doc = read("/v1/usage", plain)
	if doc.QuotaMapping != "native" || doc.RateLimits[0].Used != 0 || doc.RateLimits[0].Remaining != 100 {
		t.Fatalf("reset retained old spend: %+v", doc)
	}
	// Mixed model access is still usable, but a model-scoped allowance must not
	// become a whole-provider limit that blocks the cash-only model.
	if err := tx.Model(&db.APIKey{}).Where("id = ?", key.ID).Update("model_allowlist", pq.StringArray{"codex", "other-model"}).Error; err != nil {
		t.Fatal(err)
	}
	doc = read("/v1/usage", plain)
	if doc.QuotaMapping != "model_scoped" || len(doc.RateLimits) != 0 || len(doc.Grants) != 1 {
		t.Fatalf("mixed mapping: %+v", doc)
	}
	var reservations int64
	if err := tx.Model(&db.RequestReservation{}).Where("tenant_id = ?", tenantID).Count(&reservations).Error; err != nil {
		t.Fatal(err)
	}
	tenant, err := s.GetTenant(t.Context(), tenantID)
	if err != nil || reservations != 0 || tenant.BalanceNanoUSD != 42e9 {
		t.Fatalf("usage query created billable work: reservations=%d, balance=%d, err=%v", reservations, tenant.BalanceNanoUSD, err)
	}
	for _, change := range []struct {
		model  any
		id     string
		column string
		value  any
	}{
		{&db.APIKey{}, key.ID, "enabled", false},
		{&db.APIKey{}, key.ID, "expires_at", now.Add(-time.Minute)},
		{&db.Tenant{}, tenantID, "enabled", false},
		{&db.Tenant{}, tenantID, "expires_at", now.Add(-time.Minute)},
	} {
		if err := tx.Model(change.model).Where("id = ?", change.id).Update(change.column, change.value).Error; err != nil {
			t.Fatal(err)
		}
		if rec := get("/v1/usage", plain); rec.Code != 401 {
			t.Fatalf("revoked access: %d %s", rec.Code, rec.Body)
		}
		if err := tx.Model(change.model).Where("id = ?", change.id).Updates(map[string]any{"enabled": true, "expires_at": nil}).Error; err != nil {
			t.Fatal(err)
		}
	}
}
