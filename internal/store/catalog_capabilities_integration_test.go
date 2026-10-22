package store

import (
	"os"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/pricing"
)

func TestCatalogPersistsUnpricedCapabilitiesAtomically(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	s, err := New(database, "catalog-capability-integration-secret")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Exec("DELETE FROM runtime_settings WHERE key = ?", "models-dev-capabilities")
	result := pricing.SyncResult{Source: pricing.SourceCatalog, Version: "capability-test", Entries: []pricing.CatalogEntry{{Price: pricing.Price{Model: "priced-capability", InputNanoUSDPerToken: 1, OutputNanoUSDPerToken: 2}}}, Capabilities: []pricing.Capability{{ID: "priced-capability", Context: 100000}, {ID: "unpriced-capability", Context: 200000, MaxInput: 180000}}}
	if err := s.ApplyCatalog(t.Context(), result); err != nil {
		t.Fatal(err)
	}
	// Reopening the store must not discard models without published prices.
	reopened, err := New(database, "catalog-capability-integration-secret")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot pricing.CapabilitySnapshot
	found, err := reopened.GetRuntimeSetting(t.Context(), "models-dev-capabilities", &snapshot)
	if err != nil || !found || snapshot.Version != result.Version || len(snapshot.Items) != 2 {
		t.Fatalf("snapshot=%+v found=%v err=%v", snapshot, found, err)
	}
	idx := pricing.NewCapabilityIndex(snapshot.Version, snapshot.Items)
	c, ok := idx.Lookup("unpriced-capability")
	if !ok || c.MaxInput != 180000 {
		t.Fatalf("unpriced fact lost: %+v", c)
	}
	rows, err := s.ListCatalogPrices(t.Context())
	if err != nil || len(rows) != 1 {
		t.Fatalf("facts became artificial prices: %d %v", len(rows), err)
	}
}
