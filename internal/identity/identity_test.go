package identity

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestInvitationToken(t *testing.T) {
	plain, hash := NewInvitationToken()
	if !strings.HasPrefix(plain, "invite_") {
		t.Fatalf("token prefix = %q", plain)
	}
	if !bytes.Equal(hash, HashKey(plain)) {
		t.Fatal("stored hash does not match token")
	}
	other, _ := NewInvitationToken()
	if other == plain {
		t.Fatal("invitation tokens must be unique")
	}
}

func TestTemporaryPassword(t *testing.T) {
	first, err := NewTemporaryPassword()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewTemporaryPassword()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 24 {
		t.Fatalf("temporary password length = %d", len(first))
	}
	if first == second {
		t.Fatal("temporary passwords must be unique")
	}
	if _, err := base64.RawURLEncoding.DecodeString(first); err != nil {
		t.Fatalf("temporary password is not URL-safe: %v", err)
	}
}

func TestSessionRoundTrip(t *testing.T) {
	want := Session{Role: "tenant", TenantID: "user-1", PasswordVersion: 2, Expires: time.Now().Add(time.Hour).Unix()}
	token, err := SignSession("a sufficiently long test session secret", want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifySession("a sufficiently long test session secret", token)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("session = %+v, want %+v", got, want)
	}
}
