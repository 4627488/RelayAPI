package store

import (
	"crypto/subtle"
	"encoding/base64"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/scrypt"
)

func verifyPassword(hash, password string) (valid bool, legacy bool) {
	if strings.HasPrefix(hash, "$2") {
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil, false
	}
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false, false
	}
	n, errN := strconv.Atoi(parts[1])
	r, errR := strconv.Atoi(parts[2])
	p, errP := strconv.Atoi(parts[3])
	salt, errSalt := base64.RawURLEncoding.DecodeString(parts[4])
	want, errHash := base64.RawURLEncoding.DecodeString(parts[5])
	if errN != nil || errR != nil || errP != nil || errSalt != nil || errHash != nil || n <= 1 || r <= 0 || p <= 0 || len(want) == 0 {
		return false, false
	}
	got, err := scrypt.Key([]byte(password), salt, n, r, p, len(want))
	if err != nil {
		return false, false
	}
	return subtle.ConstantTimeCompare(got, want) == 1, true
}
