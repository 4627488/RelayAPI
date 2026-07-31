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
	if valid, needsRehash := verifyPassword(legacyHash, password); !valid || !needsRehash {
		t.Fatalf("legacy password was not accepted: valid=%v needsRehash=%v", valid, needsRehash)
	}
	if valid, _ := verifyPassword(legacyHash, "wrong"); valid {
		t.Fatal("wrong legacy password was accepted")
	}

	bcryptHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if valid, needsRehash := verifyPassword(string(bcryptHash), password); !valid || !needsRehash {
		t.Fatalf("bcrypt password result: valid=%v needsRehash=%v", valid, needsRehash)
	}

	argonHash, err := hashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if valid, needsRehash := verifyPassword(argonHash, password); !valid || needsRehash {
		t.Fatalf("argon2id password result: valid=%v needsRehash=%v", valid, needsRehash)
	}
	if valid, _ := verifyPassword(argonHash, "wrong"); valid {
		t.Fatal("wrong argon2id password was accepted")
	}
}
