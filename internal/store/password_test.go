package store

import (
	"encoding/base64"
	"fmt"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/scrypt"
)

func TestVerifyPassword(t *testing.T) {
	t.Parallel()
	password := "correct horse battery staple"
	salt := []byte("legacy-salt")
	derived, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	legacyHash := fmt.Sprintf("scrypt$16384$8$1$%s$%s", base64.RawURLEncoding.EncodeToString(salt), base64.RawURLEncoding.EncodeToString(derived))
	if valid, legacy := verifyPassword(legacyHash, password); !valid || !legacy {
		t.Fatalf("legacy password was not accepted: valid=%v legacy=%v", valid, legacy)
	}
	if valid, _ := verifyPassword(legacyHash, "wrong"); valid {
		t.Fatal("wrong legacy password was accepted")
	}

	bcryptHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if valid, legacy := verifyPassword(string(bcryptHash), password); !valid || legacy {
		t.Fatalf("bcrypt password result: valid=%v legacy=%v", valid, legacy)
	}
}
