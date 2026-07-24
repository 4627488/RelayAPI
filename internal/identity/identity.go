package identity

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Session struct {
	Role     string `json:"role"`
	TenantID string `json:"tenant_id,omitempty"`
	Expires  int64  `json:"exp"`
}

func NewID() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

func NewAPIKey() (plain, prefix string, hash []byte) {
	var value [32]byte
	_, _ = rand.Read(value[:])
	plain = "relay_" + base64.RawURLEncoding.EncodeToString(value[:])
	prefix = plain[:14]
	sum := sha256.Sum256([]byte(plain))
	return plain, prefix, sum[:]
}

func NewInvitationToken() (plain string, hash []byte) {
	var value [32]byte
	_, _ = rand.Read(value[:])
	plain = "invite_" + base64.RawURLEncoding.EncodeToString(value[:])
	return plain, HashKey(plain)
}

func HashKey(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func SignSession(secret string, session Session) (string, error) {
	payload, err := json.Marshal(session)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + hex.EncodeToString(mac.Sum(nil)), nil
}

func VerifySession(secret, token string) (Session, error) {
	encoded, signature, ok := strings.Cut(token, ".")
	if !ok {
		return Session{}, errors.New("invalid session")
	}
	provided, err := hex.DecodeString(signature)
	if err != nil {
		return Session{}, errors.New("invalid session")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encoded))
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return Session{}, errors.New("invalid session")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return Session{}, errors.New("invalid session")
	}
	var session Session
	if err := json.Unmarshal(payload, &session); err != nil || session.Expires <= time.Now().Unix() {
		return Session{}, errors.New("expired session")
	}
	return session, nil
}
