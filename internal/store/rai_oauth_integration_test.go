package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestRAIOAuthInferenceExpiryRotationAndRevocation(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	s, err := New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	tenant, err := s.CreateTenant(ctx, "OAuth", identity.NewID()+"@example.com", "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	// Previously issued rai Keys remain usable without reauthorization.
	legacy, legacyPlain, err := s.CreateKey(ctx, tenant.ID, "Legacy device", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&db.APIKey{}).Where("id = ?", legacy.ID).Updates(map[string]any{"source": "rai", "key_ciphertext": []byte(nil)}).Error; err != nil {
		t.Fatal(err)
	}
	old, err := s.ResolveKey(ctx, legacyPlain)
	if err != nil || !old.Enabled || old.Source != "rai" {
		t.Fatal("legacy device Key stopped working")
	}
	if err := s.RevokeRAIDevice(ctx, tenant.ID, legacy.ID); err != nil {
		t.Fatal(err)
	}
	old, err = s.ResolveKey(ctx, legacyPlain)
	if err != nil || old.Enabled {
		t.Fatal("revoked legacy device Key remained enabled")
	}
	grant, _, err := s.CreateRAIAuthorization(ctx, "OAuth laptop", PKCEChallengeS256(verifier), "S256", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ApproveRAIAuthorization(ctx, grant.ID, tenant.ID); err != nil {
		t.Fatal(err)
	}
	tokens, err := s.ConsumeRAIOAuthAuthorization(ctx, grant.ID, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if tokens.Purpose != "inference" || tokens.ExpiresIn > 900 || tokens.ExpiresIn < 1 {
		t.Fatalf("invalid token lifetime or purpose: %s", tokens.Purpose)
	}
	key, err := s.ResolveKey(ctx, tokens.AccessToken)
	if err != nil || key.TenantID != tenant.ID || key.Source != "rai" {
		t.Fatalf("OAuth inference authentication failed: %v", err)
	}
	if _, err := s.ResolveKey(ctx, tokens.RefreshToken); err == nil {
		t.Fatal("refresh token accepted as inference credential")
	}
	session, err := s.RAIOAuthSession(ctx, tokens.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if session.APIKeyID == nil || *session.APIKeyID != key.ID {
		t.Fatal("OAuth accounting identity is not stable")
	}
	claims, _ := json.Marshal(raiAccessClaims{SessionID: session.ID, Expires: time.Now().Add(-time.Minute).Unix()})
	sealed, err := s.secretBox.Seal(claims, "rai-oauth-access/v1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveKey(ctx, "rai_at_"+base64.RawURLEncoding.EncodeToString(sealed)); err == nil {
		t.Fatal("expired access token accepted")
	}
	if _, err := s.ResolveKey(ctx, tokens.AccessToken+"tampered"); err == nil {
		t.Fatal("tampered access token accepted")
	}
	// Competing refresh requests can consume the same refresh token only once.
	var successes atomic.Int32
	var group sync.WaitGroup
	var next RAIOAuthTokens
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			refreshed, err := s.RefreshRAIOAuth(ctx, tokens.RefreshToken)
			if err == nil {
				next = refreshed
				successes.Add(1)
			}
		}()
	}
	group.Wait()
	if successes.Load() != 1 {
		t.Fatalf("refresh token consumed %d times", successes.Load())
	}
	if next.RefreshToken == tokens.RefreshToken {
		t.Fatal("refresh token did not rotate")
	}
	if _, err := s.ResolveKey(ctx, tokens.AccessToken); err != nil {
		t.Fatal("refresh invalidated still-valid access token cached by a running client")
	}
	resolved, err := s.ResolveKey(ctx, next.AccessToken)
	if err != nil || resolved.ID != key.ID {
		t.Fatal("refresh changed the billing identity")
	}
	if err := s.RevokeRAIOAuth(ctx, next.RefreshToken); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveKey(ctx, tokens.AccessToken); err == nil {
		t.Fatal("revoked access token accepted")
	}
	if _, err := s.RefreshRAIOAuth(ctx, next.RefreshToken); err == nil {
		t.Fatal("revoked refresh token accepted")
	}
	if err := s.RevokeRAIOAuth(ctx, next.RefreshToken); err != nil {
		t.Fatal("revocation must be idempotent")
	}
}
