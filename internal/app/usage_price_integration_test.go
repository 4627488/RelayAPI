package app

import (
	"os"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestMagpieServedModelPriceAndExplicitUserOverride(t *testing.T) {
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
	defer tx.Rollback()
	requested, served := "asked-"+identity.NewID(), "served-"+identity.NewID()
	for _, p := range []db.ModelCatalogPrice{{Model: requested, InputNanoUSDPerToken: 100, Source: pricing.SourceCatalog, Version: "test"}, {Model: served, InputNanoUSDPerToken: 200, Source: pricing.SourceCatalog, Version: "test"}} {
		if err := tx.Create(&p).Error; err != nil {
			t.Fatal(err)
		}
	}
	s := store.Store{DB: tx}
	if err := s.RefreshPricing(t.Context()); err != nil {
		t.Fatal(err)
	}
	a := App{store: s}
	check := func(ask, actual string, want int64) {
		t.Helper()
		got, err := a.resolveUsagePrice(t.Context(), pricing.Dimensions{Model: ask}, actual)
		if err != nil || got.InputNanoUSDPerToken != want {
			t.Fatalf("asked=%s actual=%s: %+v %v", ask, actual, got, err)
		}
	}
	check(requested, served, 200)
	check("unknown-"+identity.NewID(), served, 200)
	check(requested, "unknown-"+identity.NewID(), 100)
	if err := a.store.UpsertPrice(t.Context(), store.Price{Model: requested, InputNanoUSDPerToken: 333, PriceMultiplier: 1}); err != nil {
		t.Fatal(err)
	}
	check(requested, served, 333)
	if err := a.store.UpsertPrice(t.Context(), store.Price{Model: requested, PriceMultiplier: 1}); err != nil {
		t.Fatal(err)
	}
	check(requested, served, 0)
}
