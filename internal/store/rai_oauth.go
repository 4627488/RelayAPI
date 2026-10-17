package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const raiAccessTTL = 15 * time.Minute
const raiRefreshMonths = 6

type RAIOAuthTokens struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	Purpose          string `json:"purpose"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
}

type raiAccessClaims struct {
	SessionID string `json:"sid"`
	Expires   int64  `json:"exp"`
}

func (s Store) issueRAIOAuthTokens(session db.RAIOAuthSession) (RAIOAuthTokens, error) {
	expires := time.Now().Add(raiAccessTTL)
	if session.ExpiresAt.Before(expires) {
		expires = session.ExpiresAt
	}
	claims, _ := json.Marshal(raiAccessClaims{SessionID: session.ID, Expires: expires.Unix()})
	sealed, err := s.secretBox.Seal(claims, "rai-oauth-access/v1")
	if err != nil {
		return RAIOAuthTokens{}, err
	}
	return RAIOAuthTokens{AccessToken: "rai_at_" + base64.RawURLEncoding.EncodeToString(sealed),
		RefreshToken: "rai_rt_" + rand.Text(), TokenType: "Bearer", Purpose: session.Purpose,
		ExpiresIn: int(time.Until(expires).Seconds()), RefreshExpiresIn: int(time.Until(session.ExpiresAt).Seconds())}, nil
}

func (s Store) RAIOAuthSession(ctx context.Context, token string) (db.RAIOAuthSession, error) {
	var item db.RAIOAuthSession
	if !strings.HasPrefix(token, "rai_at_") || len(token) > 2048 {
		return item, ErrInvalidGrant
	}
	sealed, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, "rai_at_"))
	if err != nil {
		return item, ErrInvalidGrant
	}
	opened, err := s.secretBox.Open(sealed, "rai-oauth-access/v1")
	if err != nil {
		return item, ErrInvalidGrant
	}
	var claims raiAccessClaims
	if json.Unmarshal(opened, &claims) != nil || claims.Expires <= time.Now().Unix() {
		return item, ErrInvalidGrant
	}
	err = scoped(ctx, s.DB).Table("rai_oauth_sessions").Select("rai_oauth_sessions.*").
		Joins("JOIN tenants ON tenants.id = rai_oauth_sessions.tenant_id").
		Where("rai_oauth_sessions.id = ? AND rai_oauth_sessions.expires_at > ?", claims.SessionID, time.Now()).
		Where("tenants.enabled AND NOT tenants.must_change_password AND tenants.password_version = rai_oauth_sessions.password_version").
		Where("tenants.expires_at IS NULL OR tenants.expires_at > ?", time.Now()).Take(&item).Error
	return item, notFound(err)
}

func (s Store) RefreshRAIOAuth(ctx context.Context, refreshToken string) (RAIOAuthTokens, error) {
	var tokens RAIOAuthTokens
	if !strings.HasPrefix(refreshToken, "rai_rt_") || len(refreshToken) > 256 {
		return tokens, ErrInvalidGrant
	}
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var session db.RAIOAuthSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("refresh_token_hash = ?", identity.HashKey(refreshToken)).First(&session).Error; err != nil {
			return ErrInvalidGrant
		}
		if !session.ExpiresAt.After(time.Now()) {
			return ErrInvalidGrant
		}
		var tenant db.Tenant
		if err := tx.First(&tenant, "id = ?", session.TenantID).Error; err != nil {
			return ErrInvalidGrant
		}
		if !tenant.Enabled || tenant.MustChangePassword || tenant.PasswordVersion != session.PasswordVersion || (tenant.ExpiresAt != nil && !tenant.ExpiresAt.After(time.Now())) {
			return ErrInvalidGrant
		}
		if session.APIKeyID != nil {
			var key APIKey
			if err := tx.First(&key, "id = ? AND tenant_id = ? AND enabled", *session.APIKeyID, tenant.ID).Error; err != nil {
				return ErrInvalidGrant
			}
		}
		var err error
		tokens, err = s.issueRAIOAuthTokens(session)
		if err != nil {
			return err
		}
		return tx.Model(&session).Update("refresh_token_hash", identity.HashKey(tokens.RefreshToken)).Error
	})
	return tokens, err
}

func (s Store) RevokeRAIOAuthSession(ctx context.Context, tenantID, id string) error {
	result := scoped(ctx, s.DB).Where("tenant_id = ? AND id = ?", tenantID, id).Delete(&db.RAIOAuthSession{})
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) RevokeRAIOAuth(ctx context.Context, refreshToken string) error {
	if !strings.HasPrefix(refreshToken, "rai_rt_") || len(refreshToken) > 256 {
		return nil
	}
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var session db.RAIOAuthSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("refresh_token_hash = ?", identity.HashKey(refreshToken)).First(&session).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return nil
			}
			return err
		}
		if session.APIKeyID != nil {
			if err := tx.Model(&APIKey{}).Where("id = ? AND tenant_id = ? AND source = ?", *session.APIKeyID, session.TenantID, "rai").Update("enabled", false).Error; err != nil {
				return err
			}
		}
		return tx.Delete(&session).Error
	})
}
