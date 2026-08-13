package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestOutboundProxyEncryptedCRUDAndReferences(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err = database.Exec(`TRUNCATE upstream_credentials, outbound_proxies`).Error; err != nil {
		t.Fatal(err)
	}
	dataStore, err := New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	created, err := dataStore.CreateOutboundProxy(ctx, "Tokyo", "socks5h://user:secret@proxy.example:1080")
	if err != nil {
		t.Fatal(err)
	}
	var persisted db.OutboundProxy
	if err = database.First(&persisted, "id = ?", created.ID).Error; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(persisted.SealedURL), "secret") || strings.Contains(string(persisted.SealedURL), "proxy.example") {
		t.Fatal("proxy URL was stored in plaintext")
	}
	updated, err := dataStore.UpdateOutboundProxy(ctx, created.ID, "Tokyo rotated", "http://rotated.example:8080")
	if err != nil || updated.Name != "Tokyo rotated" || updated.URL != "http://rotated.example:8080" {
		t.Fatalf("updated proxy = %#v, err = %v", updated, err)
	}
	if _, err = dataStore.UpsertUpstreamCredential(ctx, UpstreamCredentialInput{
		ID: "proxy-test", Name: "proxy-test", Provider: "openai", Enabled: true,
		Document: []byte(`{"type":"openai","api_key":"secret"}`), Source: "test", ProxyID: &created.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if count, countErr := dataStore.CountOutboundProxyReferences(ctx, created.ID); countErr != nil || count != 1 {
		t.Fatalf("references = %d, err = %v", count, countErr)
	}
	if err = dataStore.DeleteOutboundProxy(ctx, created.ID); err == nil {
		t.Fatal("proxy in use was deleted")
	}
	if err = dataStore.DeleteUpstreamCredential(ctx, "proxy-test"); err != nil {
		t.Fatal(err)
	}
	if err = dataStore.DeleteOutboundProxy(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
}
