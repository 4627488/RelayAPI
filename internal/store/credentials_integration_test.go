package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestUpsertUpstreamCredentialUpdatesEncryptedDocument(t *testing.T) {
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
	if err := database.Exec(`TRUNCATE upstream_credentials`).Error; err != nil {
		t.Fatal(err)
	}
	dataStore, err := New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	input := UpstreamCredentialInput{
		ID: "credential.json", Name: "credential", Provider: "codex", Enabled: true,
		Models: []string{"gpt-test"}, Document: json.RawMessage(`{"access_token":"first"}`), Source: "test",
	}
	first, err := dataStore.UpsertUpstreamCredential(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Document = json.RawMessage(`{"access_token":"second"}`)
	second, err := dataStore.UpsertUpstreamCredential(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || second.Revision != 2 || string(second.Document) != string(input.Document) {
		t.Fatalf("revisions/documents = %d, %d, %s", first.Revision, second.Revision, second.Document)
	}
}
