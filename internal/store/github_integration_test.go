package store

import (
	"context"
	"os"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestGitHubBindingIsolationIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	database, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tx := database.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	err = tx.Exec(`CREATE TEMP TABLE tenants (id text PRIMARY KEY, github_id bigint UNIQUE, github_login text DEFAULT '', password_version bigint DEFAULT 0, enabled boolean DEFAULT true, must_change_password boolean DEFAULT false, expires_at timestamptz, updated_at timestamptz) ON COMMIT DROP`).Error
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Exec(`INSERT INTO tenants(id) VALUES ('a'),('b'),('disabled'),('expired')`).Error; err != nil {
		t.Fatal(err)
	}
	tx.Exec(`UPDATE tenants SET enabled=false WHERE id='disabled'`)
	tx.Exec(`UPDATE tenants SET expires_at=now()-interval '1 hour' WHERE id='expired'`)
	s := Store{DB: tx}
	ctx := context.Background()
	if err = s.BindGitHub(ctx, "a", 0, 42, "name"); err != nil {
		t.Fatal(err)
	}
	if err = s.BindGitHub(ctx, "a", 0, 43, "other"); err == nil {
		t.Fatal("overwrote existing binding")
	}
	tx.SavePoint("unique_check")
	if err = s.BindGitHub(ctx, "b", 0, 42, "name"); err == nil {
		t.Fatal("identity linked twice")
	}
	tx.RollbackTo("unique_check")
	for _, id := range []string{"disabled", "expired"} {
		if err = s.BindGitHub(ctx, id, 0, 44, "name"); err == nil {
			t.Fatal("inactive account bound")
		}
	}
	if err = s.BindGitHub(ctx, "b", 99, 45, "name"); err == nil {
		t.Fatal("stale session bound")
	}
	got, err := s.GitHubTenant(ctx, 42)
	if err != nil || got.ID != "a" || got.GitHubID == nil || *got.GitHubID != 42 || got.GitHubLogin != "name" {
		t.Fatalf("login mismatch: %v", err)
	}
	if err = s.UnbindGitHub(ctx, "a", 0); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GitHubTenant(ctx, 42); err == nil {
		t.Fatal("unbound identity logged in")
	}
	var version int64
	tx.Raw(`SELECT password_version FROM tenants WHERE id='a'`).Scan(&version)
	if version != 1 {
		t.Fatal("sessions not invalidated")
	}
	if err = s.BindGitHub(ctx, "a", 0, 42, "name"); err == nil {
		t.Fatal("old callback rebound after unlink")
	}
}
