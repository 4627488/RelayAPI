package store

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/scrypt"
)

const (
	argonMemory  = 64 * 1024
	argonTime    = 3
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

func hashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}

func verifyPassword(hash, password string) (valid bool, needsRehash bool) {
	switch {
	case strings.HasPrefix(hash, "$argon2id$"):
		return verifyArgon2id(hash, password), false
	case strings.HasPrefix(hash, "$2"):
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil, true
	default:
		return verifyScrypt(hash, password), true
	}
}

func verifyArgon2id(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory uint32
	var iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	salt, errSalt := base64.RawStdEncoding.DecodeString(parts[4])
	want, errHash := base64.RawStdEncoding.DecodeString(parts[5])
	if errSalt != nil || errHash != nil || memory == 0 || iterations == 0 || threads == 0 || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func verifyScrypt(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, errN := strconv.Atoi(parts[1])
	r, errR := strconv.Atoi(parts[2])
	p, errP := strconv.Atoi(parts[3])
	salt, errSalt := base64.RawURLEncoding.DecodeString(parts[4])
	want, errHash := base64.RawURLEncoding.DecodeString(parts[5])
	if errN != nil || errR != nil || errP != nil || errSalt != nil || errHash != nil || n <= 1 || r <= 0 || p <= 0 || len(want) == 0 {
		return false
	}
	got, err := scrypt.Key([]byte(password), salt, n, r, p, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}
