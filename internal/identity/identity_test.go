package identity

import (
	"bytes"
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

func TestSessionRoundTrip(t *testing.T) {
	want := Session{Role: "tenant", TenantID: "user-1", Expires: time.Now().Add(time.Hour).Unix()}
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
