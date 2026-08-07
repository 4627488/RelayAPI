package identity

import (
	"crypto/aes"
	"crypto/cipher"
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

const sealedSecretVersion byte = 1

// SecretBox encrypts recoverable credentials at rest. The caller supplies
// stable associated data (normally the tenant and record IDs), so ciphertext
// copied to another row cannot be decrypted there.
type SecretBox struct {
	aead cipher.AEAD
}

func NewSecretBox(secret string) (SecretBox, error) {
	key := sha256.Sum256([]byte("relayapi/secret-box/v1\x00" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return SecretBox{}, fmt.Errorf("create secret cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return SecretBox{}, fmt.Errorf("create secret box: %w", err)
	}
	return SecretBox{aead: aead}, nil
}

func (b SecretBox) Seal(plain []byte, associatedData string) ([]byte, error) {
	if b.aead == nil {
		return nil, errors.New("secret box is not initialized")
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate secret nonce: %w", err)
	}
	sealed := make([]byte, 1, 1+len(nonce)+len(plain)+b.aead.Overhead())
	sealed[0] = sealedSecretVersion
	sealed = append(sealed, nonce...)
	return b.aead.Seal(sealed, nonce, plain, []byte(associatedData)), nil
}

func (b SecretBox) Open(sealed []byte, associatedData string) ([]byte, error) {
	if b.aead == nil {
		return nil, errors.New("secret box is not initialized")
	}
	if len(sealed) < 1+b.aead.NonceSize()+b.aead.Overhead() || sealed[0] != sealedSecretVersion {
		return nil, errors.New("invalid sealed secret")
	}
	nonce := sealed[1 : 1+b.aead.NonceSize()]
	plain, err := b.aead.Open(nil, nonce, sealed[1+b.aead.NonceSize():], []byte(associatedData))
	if err != nil {
		return nil, errors.New("decrypt sealed secret")
	}
	return plain, nil
}

type Session struct {
	Role            string `json:"role"`
	TenantID        string `json:"tenant_id,omitempty"`
	PasswordVersion int64  `json:"password_version,omitempty"`
	Expires         int64  `json:"exp"`
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

func NewTemporaryPassword() (string, error) {
	var value [18]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
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
