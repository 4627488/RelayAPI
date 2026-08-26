package rai

import (
	"os"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestFileCredentialRoundTrip(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	backend, err := store.PutCredential("default", "relay_secret-key")
	if err != nil {
		t.Fatal(err)
	}
	if backend != "file" {
		t.Fatalf("backend = %q", backend)
	}
	got, err := store.Credential("default")
	if err != nil || got != "relay_secret-key" {
		t.Fatalf("got %q err=%v", got, err)
	}
	info, err := os.Stat(store.credentialsPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode = %o", info.Mode().Perm())
	}
	if err := store.DeleteCredential("default"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Credential("default"); err == nil {
		t.Fatal("deleted credential still present")
	}
}

func TestKeyringCredentialRoundTrip(t *testing.T) {
	keyring.MockInit()
	t.Setenv(envDisableKey, "0")
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	backend, err := store.PutCredential("work", "relay_keyring")
	if err != nil {
		t.Fatal(err)
	}
	if backend != "keyring" {
		t.Fatalf("backend = %q", backend)
	}
	got, err := store.Credential("work")
	if err != nil || got != "relay_keyring" {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestRedactHidesKeysAndBearerTokens(t *testing.T) {
	got := redact("Authorization: Bearer relay_abc and relay_abc")
	if got != "Authorization: Bearer *** and relay_***" && got == "Authorization: Bearer relay_abc and relay_abc" {
		t.Fatalf("redact left secrets visible: %q", got)
	}
	if keyPrefix("relay_abcdefghijk") != "relay_abcd…" {
		t.Fatalf("prefix = %q", keyPrefix("relay_abcdefghijk"))
	}
}
