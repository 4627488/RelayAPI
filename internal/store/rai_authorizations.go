package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	RAIAuthorizationPending  = "pending"
	RAIAuthorizationApproved = "approved"
	RAIAuthorizationDenied   = "denied"
	RAIAuthorizationConsumed = "consumed"
	raiAuthorizationTTL      = 10 * time.Minute
	raiAuthorizationInterval = 3
)

var (
	ErrAuthorizationPending = errors.New("authorization_pending")
	ErrAuthorizationDenied  = errors.New("access_denied")
	ErrAuthorizationExpired = errors.New("expired_token")
	ErrInvalidGrant         = errors.New("invalid_grant")
)

type RAIAuthorization struct {
	ID         string
	DeviceName string
	Status     string
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

func raiAuthorizationAssociatedData(id string) string {
	return "rai-authorization/" + id
}

func (s Store) CreateRAIAuthorization(ctx context.Context, deviceName, challenge, method string, now time.Time) (RAIAuthorization, int, error) {
	deviceName, err := normalizeRAIDeviceName(deviceName)
	if err != nil {
		return RAIAuthorization{}, 0, err
	}
	challenge, err = normalizePKCEChallenge(challenge)
	if err != nil {
		return RAIAuthorization{}, 0, err
	}
	if method == "" {
		method = "S256"
	}
	if !strings.EqualFold(method, "S256") {
		return RAIAuthorization{}, 0, errors.New("code_challenge_method must be S256")
	}
	if now.IsZero() {
		now = time.Now()
	}
	item := db.RAIAuthorization{
		ID:                  identity.NewID(),
		DeviceName:          deviceName,
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
		Status:              RAIAuthorizationPending,
		CreatedAt:           now,
		ExpiresAt:           now.Add(raiAuthorizationTTL),
	}
	if err := scoped(ctx, s.DB).Create(&item).Error; err != nil {
		return RAIAuthorization{}, 0, err
	}
	return RAIAuthorization{
		ID:         item.ID,
		DeviceName: item.DeviceName,
		Status:     item.Status,
		ExpiresAt:  item.ExpiresAt,
		CreatedAt:  item.CreatedAt,
	}, raiAuthorizationInterval, nil
}

func (s Store) RAIAuthorization(ctx context.Context, id string) (RAIAuthorization, error) {
	item, err := s.loadRAIAuthorization(ctx, strings.TrimSpace(id))
	if err != nil {
		return RAIAuthorization{}, err
	}
	status := item.Status
	if item.Status == RAIAuthorizationPending && !item.ExpiresAt.After(time.Now()) {
		status = "expired"
	}
	return RAIAuthorization{
		ID:         item.ID,
		DeviceName: item.DeviceName,
		Status:     status,
		ExpiresAt:  item.ExpiresAt,
		CreatedAt:  item.CreatedAt,
	}, nil
}

func (s Store) ApproveRAIAuthorization(ctx context.Context, id, tenantID string) error {
	id = strings.TrimSpace(id)
	tenantID = strings.TrimSpace(tenantID)
	if id == "" || tenantID == "" {
		return ErrNotFound
	}
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var item db.RAIAuthorization
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", id).Error; err != nil {
			return notFound(err)
		}
		if !item.ExpiresAt.After(time.Now()) {
			return ErrAuthorizationExpired
		}
		if item.Status != RAIAuthorizationPending {
			return ErrInvalidGrant
		}
		plain, prefix, hash := identity.NewAPIKey()
		key := APIKey{
			ID: identity.NewID(), TenantID: tenantID, Name: raiKeyName(item.DeviceName),
			KeyHash: hash, Prefix: prefix, Enabled: true,
		}
		ciphertext, err := s.secretBox.Seal([]byte(plain), keySecretAssociatedData(tenantID, key.ID))
		if err != nil {
			return err
		}
		key.KeyCiphertext = ciphertext
		key.Recoverable = true
		if err := tx.Create(&key).Error; err != nil {
			return err
		}
		sealed, err := s.secretBox.Seal([]byte(plain), raiAuthorizationAssociatedData(item.ID))
		if err != nil {
			return err
		}
		now := time.Now()
		return tx.Model(&item).Updates(map[string]any{
			"tenant_id":          tenantID,
			"status":             RAIAuthorizationApproved,
			"api_key_id":         key.ID,
			"api_key_ciphertext": sealed,
			"approved_at":        now,
		}).Error
	})
}

func (s Store) DenyRAIAuthorization(ctx context.Context, id, tenantID string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrNotFound
	}
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var item db.RAIAuthorization
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", id).Error; err != nil {
			return notFound(err)
		}
		if item.Status != RAIAuthorizationPending {
			return ErrInvalidGrant
		}
		now := time.Now()
		return tx.Model(&item).Updates(map[string]any{
			"tenant_id":   strings.TrimSpace(tenantID),
			"status":      RAIAuthorizationDenied,
			"approved_at": now,
		}).Error
	})
}

func (s Store) ConsumeRAIAuthorization(ctx context.Context, id, verifier string) (string, error) {
	id = strings.TrimSpace(id)
	verifier = strings.TrimSpace(verifier)
	if id == "" || verifier == "" {
		return "", ErrInvalidGrant
	}
	var plain string
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var item db.RAIAuthorization
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", id).Error; err != nil {
			return ErrInvalidGrant
		}
		if !item.ExpiresAt.After(time.Now()) && item.Status != RAIAuthorizationConsumed {
			return ErrAuthorizationExpired
		}
		switch item.Status {
		case RAIAuthorizationPending:
			return ErrAuthorizationPending
		case RAIAuthorizationDenied:
			return ErrAuthorizationDenied
		case RAIAuthorizationConsumed:
			return ErrInvalidGrant
		case RAIAuthorizationApproved:
		default:
			return ErrInvalidGrant
		}
		if !pkceChallengeMatches(item.CodeChallenge, verifier) {
			return ErrInvalidGrant
		}
		opened, err := s.secretBox.Open(item.APIKeyCiphertext, raiAuthorizationAssociatedData(item.ID))
		if err != nil {
			return ErrInvalidGrant
		}
		now := time.Now()
		if err := tx.Model(&item).Updates(map[string]any{
			"status":             RAIAuthorizationConsumed,
			"api_key_ciphertext": []byte(nil),
			"consumed_at":        now,
		}).Error; err != nil {
			return err
		}
		plain = string(opened)
		return nil
	})
	return plain, err
}

func (s Store) DeleteExpiredRAIAuthorizations(ctx context.Context, now time.Time) (int64, error) {
	result := scoped(ctx, s.DB).Where("expires_at <= ?", now).Delete(&db.RAIAuthorization{})
	return result.RowsAffected, result.Error
}

func (s Store) loadRAIAuthorization(ctx context.Context, id string) (db.RAIAuthorization, error) {
	if id == "" {
		return db.RAIAuthorization{}, ErrNotFound
	}
	var item db.RAIAuthorization
	err := scoped(ctx, s.DB).First(&item, "id = ?", id).Error
	return item, notFound(err)
}

func raiKeyName(device string) string {
	device = strings.TrimSpace(device)
	if device == "" {
		return "rai"
	}
	return "rai · " + device
}

func normalizeRAIDeviceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "rai", nil
	}
	if len(name) > 64 {
		return "", errors.New("device name is too long")
	}
	for _, r := range name {
		if r == '\n' || r == '\r' || r == 0 || !unicode.IsPrint(r) {
			return "", errors.New("device name is invalid")
		}
	}
	return name, nil
}

func normalizePKCEChallenge(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 43 || len(value) > 128 {
		return "", errors.New("code_challenge must be 43-128 characters")
	}
	for _, r := range value {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '.' || r == '_' || r == '~' {
			continue
		}
		return "", errors.New("code_challenge is invalid")
	}
	return value, nil
}

func pkceChallengeMatches(challenge, verifier string) bool {
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return got == challenge
}

func PKCEChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
