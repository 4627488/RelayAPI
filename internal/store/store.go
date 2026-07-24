package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrNotFound = errors.New("not found")

type Store struct{ DB *gorm.DB }
type Tenant = db.Tenant
type APIKey = db.APIKey
type Price = db.ModelPrice
type Invitation = db.Invitation

type KeyContext struct {
	APIKey
	TenantName       string
	TenantEnabled    bool
	TenantBalance    int64
	TenantRateLimit  *int
	TenantTokenLimit *int64
	TenantModels     []string
	TenantExpiresAt  *time.Time
}

type Usage struct{ Prompt, Completion, Cached, CacheWrite, Reasoning, Total int64 }

type LogInput struct {
	ID, TenantID, APIKeyID, CPARequestID, Model, Provider, AuthIndex, Method, Path string
	StatusCode                                                                     int
	Stream, PricingComplete, Settled                                               bool
	Usage                                                                          Usage
	CostNanoUSD                                                                    *int64
	ReservedNanoUSD, LatencyMS                                                     int64
	ErrorMessage                                                                   string
	StartedAt, CompletedAt                                                         time.Time
}

func scoped(ctx context.Context, database *gorm.DB) *gorm.DB { return database.WithContext(ctx) }
func notFound(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	return err
}

func (s Store) ListTenants(ctx context.Context) ([]Tenant, error) {
	var result []Tenant
	err := scoped(ctx, s.DB).Order("created_at DESC").Find(&result).Error
	return result, err
}

func (s Store) GetTenant(ctx context.Context, id string) (Tenant, error) {
	var item Tenant
	err := scoped(ctx, s.DB).First(&item, "id = ?", id).Error
	return item, notFound(err)
}

func (s Store) CreateTenant(ctx context.Context, name, email, password string, rate *int, tokens *int64, models []string) (Tenant, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return Tenant{}, err
	}
	item := Tenant{
		ID: identity.NewID(), Name: strings.TrimSpace(name), OwnerEmail: strings.ToLower(strings.TrimSpace(email)),
		PasswordHash: string(hash), Enabled: true, RateLimitPerMinute: rate, TokenLimitDaily: tokens,
		ModelAllowlist: models,
	}
	err = scoped(ctx, s.DB).Create(&item).Error
	return item, err
}

func (s Store) UpdateTenant(ctx context.Context, id, name, email string, enabled bool, rate *int, tokens *int64, models []string) (Tenant, error) {
	result := scoped(ctx, s.DB).Model(&Tenant{}).Where("id = ?", id).Updates(map[string]any{
		"name": strings.TrimSpace(name), "owner_email": strings.ToLower(strings.TrimSpace(email)),
		"enabled": enabled, "rate_limit_per_minute": rate, "token_limit_daily": tokens,
		"model_allowlist": models, "updated_at": time.Now(),
	})
	if result.Error != nil {
		return Tenant{}, result.Error
	}
	if result.RowsAffected == 0 {
		return Tenant{}, ErrNotFound
	}
	return s.GetTenant(ctx, id)
}

func (s Store) ResetPassword(ctx context.Context, tenantID, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}
	result := scoped(ctx, s.DB).Model(&Tenant{}).Where("id = ?", tenantID).
		Updates(map[string]any{"password_hash": string(hash), "updated_at": time.Now()})
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) Login(ctx context.Context, email, password string) (Tenant, error) {
	var tenant Tenant
	err := scoped(ctx, s.DB).Where("lower(owner_email) = lower(?)", strings.TrimSpace(email)).
		Where("enabled = ? AND (expires_at IS NULL OR expires_at > ?)", true, time.Now()).First(&tenant).Error
	if err != nil || bcrypt.CompareHashAndPassword([]byte(tenant.PasswordHash), []byte(password)) != nil {
		return Tenant{}, ErrNotFound
	}
	return tenant, nil
}

func (s Store) ListKeys(ctx context.Context, tenantID string) ([]APIKey, error) {
	var result []APIKey
	err := scoped(ctx, s.DB).Where("tenant_id = ?", tenantID).Order("created_at DESC").Find(&result).Error
	return result, err
}

func (s Store) CreateKey(ctx context.Context, tenantID, name string, rate *int, tokens *int64, models []string) (APIKey, string, error) {
	plain, prefix, hash := identity.NewAPIKey()
	item := APIKey{
		ID: identity.NewID(), TenantID: tenantID, Name: strings.TrimSpace(name), KeyHash: hash,
		Prefix: prefix, Enabled: true, RateLimitPerMinute: rate, TokenLimitDaily: tokens, ModelAllowlist: models,
	}
	err := scoped(ctx, s.DB).Create(&item).Error
	return item, plain, err
}

func (s Store) DeleteKey(ctx context.Context, tenantID, id string) error {
	result := scoped(ctx, s.DB).Where("id = ? AND tenant_id = ?", id, tenantID).Delete(&APIKey{})
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) ResolveKey(ctx context.Context, plain string) (KeyContext, error) {
	var key APIKey
	if err := scoped(ctx, s.DB).Where("key_hash = ?", identity.HashKey(plain)).First(&key).Error; err != nil {
		return KeyContext{}, notFound(err)
	}
	var tenant Tenant
	if err := scoped(ctx, s.DB).First(&tenant, "id = ?", key.TenantID).Error; err != nil {
		return KeyContext{}, notFound(err)
	}
	return KeyContext{
		APIKey: key, TenantName: tenant.Name, TenantEnabled: tenant.Enabled,
		TenantBalance: tenant.BalanceNanoUSD, TenantRateLimit: tenant.RateLimitPerMinute,
		TenantTokenLimit: tenant.TokenLimitDaily, TenantModels: tenant.ModelAllowlist,
		TenantExpiresAt: tenant.ExpiresAt,
	}, nil
}

func (s Store) TouchKey(ctx context.Context, id string) {
	now := time.Now()
	_ = scoped(ctx, s.DB).Model(&APIKey{}).Where("id = ?", id).Update("last_used_at", &now).Error
}

func (s Store) DailyTokens(ctx context.Context, tenantID, keyID string) (tenant, key int64, err error) {
	type totals struct{ Tenant, Key int64 }
	var value totals
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	err = scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select("COALESCE(sum(total_tokens),0) AS tenant, COALESCE(sum(CASE WHEN api_key_id = ? THEN total_tokens ELSE 0 END),0) AS key", keyID).
		Where("tenant_id = ? AND started_at >= ?", tenantID, dayStart).Scan(&value).Error
	return value.Tenant, value.Key, err
}

func (s Store) Reserve(ctx context.Context, tenantID, requestID string, amount int64) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var tenant Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", tenantID).Error; err != nil {
			return err
		}
		if !tenant.Enabled || tenant.BalanceNanoUSD < amount {
			return errors.New("insufficient balance")
		}
		tenant.BalanceNanoUSD -= amount
		if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
			return err
		}
		return tx.Create(&db.BillingLedger{
			ID: identity.NewID(), TenantID: tenantID, RequestID: &requestID, Kind: "reservation",
			AmountNanoUSD: -amount, BalanceAfterNanoUSD: tenant.BalanceNanoUSD, Note: "request reserve",
		}).Error
	})
}

func (s Store) Settle(ctx context.Context, tenantID, requestID string, reserved, actual int64) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var tenant Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", tenantID).Error; err != nil {
			return err
		}
		delta := reserved - actual
		tenant.BalanceNanoUSD += delta
		if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
			return err
		}
		kind := "settlement"
		if actual == 0 {
			kind = "refund"
		}
		return tx.Create(&db.BillingLedger{
			ID: identity.NewID(), TenantID: tenantID, RequestID: &requestID, Kind: kind,
			AmountNanoUSD: delta, BalanceAfterNanoUSD: tenant.BalanceNanoUSD,
			Note: fmt.Sprintf("reserve=%d actual=%d", reserved, actual),
		}).Error
	})
}

func (s Store) Credit(ctx context.Context, tenantID string, amount int64, note string) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var tenant Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", tenantID).Error; err != nil {
			return err
		}
		tenant.BalanceNanoUSD += amount
		if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
			return err
		}
		return tx.Create(&db.BillingLedger{
			ID: identity.NewID(), TenantID: tenantID, Kind: "credit", AmountNanoUSD: amount,
			BalanceAfterNanoUSD: tenant.BalanceNanoUSD, Note: note,
		}).Error
	})
}

func (s Store) Price(ctx context.Context, model string) (Price, error) {
	var price Price
	candidates := []string{model}
	if i := strings.LastIndex(model, "/"); i >= 0 {
		candidates = append(candidates, model[i+1:])
	}
	for _, candidate := range candidates {
		if err := scoped(ctx, s.DB).First(&price, "model = ?", candidate).Error; err == nil {
			return price, nil
		}
	}
	return Price{}, ErrNotFound
}

func (s Store) ListPrices(ctx context.Context) ([]Price, error) {
	var result []Price
	err := scoped(ctx, s.DB).Order("model").Find(&result).Error
	return result, err
}

func (s Store) UpsertPrice(ctx context.Context, price Price) error {
	price.Source = "admin"
	return scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "model"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"input_nano_usd_per_token", "output_nano_usd_per_token", "cached_input_nano_usd_per_token",
			"cache_write_nano_usd_per_token", "reasoning_nano_usd_per_token", "source", "updated_at",
		}),
	}).Create(&price).Error
}

func (s Store) WriteLog(ctx context.Context, l LogInput) error {
	return scoped(ctx, s.DB).Create(&db.RequestLog{
		ID: l.ID, TenantID: l.TenantID, APIKeyID: l.APIKeyID, CPARequestID: l.CPARequestID, Model: l.Model,
		Provider: l.Provider, AuthIndex: l.AuthIndex, Method: l.Method, Path: l.Path, StatusCode: l.StatusCode,
		Stream: l.Stream, PromptTokens: l.Usage.Prompt, CompletionTokens: l.Usage.Completion,
		CachedTokens: l.Usage.Cached, CacheWriteTokens: l.Usage.CacheWrite, ReasoningTokens: l.Usage.Reasoning,
		TotalTokens: l.Usage.Total, CostNanoUSD: l.CostNanoUSD, PricingComplete: l.PricingComplete,
		Settled: l.Settled, ReservedNanoUSD: l.ReservedNanoUSD, LatencyMS: l.LatencyMS,
		ErrorMessage: l.ErrorMessage, StartedAt: l.StartedAt, CompletedAt: l.CompletedAt,
	}).Error
}

func (s Store) Dashboard(ctx context.Context, tenantID string) (map[string]any, error) {
	var tenant Tenant
	if err := scoped(ctx, s.DB).First(&tenant, "id = ?", tenantID).Error; err != nil {
		return nil, notFound(err)
	}
	type totals struct{ Requests, Tokens, Cost int64 }
	var total totals
	err := scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select("count(*) AS requests, COALESCE(sum(total_tokens),0) AS tokens, COALESCE(sum(cost_nano_usd),0) AS cost").
		Where("tenant_id = ? AND started_at >= ?", tenantID, time.Now().AddDate(0, 0, -30)).Scan(&total).Error
	if err != nil {
		return nil, err
	}
	return map[string]any{"tenant": tenant, "requests_30d": total.Requests, "tokens_30d": total.Tokens, "cost_nano_usd_30d": total.Cost}, nil
}

func (s Store) RecentLogs(ctx context.Context, tenantID string, limit int) ([]db.RequestLog, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	var result []db.RequestLog
	query := scoped(ctx, s.DB).Order("started_at DESC").Limit(limit)
	if tenantID != "" {
		query = query.Where("tenant_id = ?", tenantID)
	}
	err := query.Find(&result).Error
	return result, err
}

func (s Store) CreateInvitation(ctx context.Context, email string, expiresAt time.Time) (Invitation, string, error) {
	plain, hash := identity.NewInvitationToken()
	item := Invitation{
		ID: identity.NewID(), TokenHash: hash,
		Email: strings.ToLower(strings.TrimSpace(email)), ExpiresAt: expiresAt,
	}
	err := scoped(ctx, s.DB).Create(&item).Error
	return item, plain, err
}

func (s Store) ListInvitations(ctx context.Context) ([]Invitation, error) {
	var result []Invitation
	err := scoped(ctx, s.DB).Order("created_at DESC").Find(&result).Error
	return result, err
}

func (s Store) RevokeInvitation(ctx context.Context, id string) error {
	now := time.Now()
	result := scoped(ctx, s.DB).Model(&Invitation{}).
		Where("id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", id, now).
		Update("revoked_at", &now)
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) RegisterWithInvitation(ctx context.Context, token, name, email, password string) (Tenant, error) {
	token = strings.TrimSpace(token)
	email = strings.ToLower(strings.TrimSpace(email))
	if token == "" {
		return Tenant{}, ErrNotFound
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return Tenant{}, err
	}
	var user Tenant
	err = scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var invitation Invitation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", identity.HashKey(token), time.Now()).
			First(&invitation).Error; err != nil {
			return ErrNotFound
		}
		if invitation.Email != "" && !strings.EqualFold(invitation.Email, email) {
			return ErrNotFound
		}
		user = Tenant{
			ID: identity.NewID(), Name: strings.TrimSpace(name), OwnerEmail: email,
			PasswordHash: string(passwordHash), Enabled: true,
		}
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		now := time.Now()
		return tx.Model(&invitation).Updates(map[string]any{
			"used_at": &now, "used_by_tenant_id": user.ID,
		}).Error
	})
	return user, err
}

func (s Store) AdminOverview(ctx context.Context) (map[string]any, error) {
	var users, enabledUsers, activeKeys, pendingInvitations int64
	database := scoped(ctx, s.DB)
	if err := database.Model(&Tenant{}).Count(&users).Error; err != nil {
		return nil, err
	}
	if err := database.Model(&Tenant{}).Where("enabled = ?", true).Count(&enabledUsers).Error; err != nil {
		return nil, err
	}
	if err := database.Model(&APIKey{}).Where("enabled = ?", true).Count(&activeKeys).Error; err != nil {
		return nil, err
	}
	if err := database.Model(&Invitation{}).
		Where("used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", time.Now()).
		Count(&pendingInvitations).Error; err != nil {
		return nil, err
	}
	type totals struct {
		Requests int64
		Tokens   int64
		Cost     int64
		Errors   int64
	}
	var today totals
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if err := database.Model(&db.RequestLog{}).Select(
		"count(*) AS requests, COALESCE(sum(total_tokens),0) AS tokens, "+
			"COALESCE(sum(cost_nano_usd),0) AS cost, "+
			"COALESCE(sum(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END),0) AS errors",
	).Where("started_at >= ?", dayStart).Scan(&today).Error; err != nil {
		return nil, err
	}
	return map[string]any{
		"users": users, "enabled_users": enabledUsers, "active_api_keys": activeKeys,
		"pending_invitations": pendingInvitations,
		"today": map[string]int64{
			"requests": today.Requests, "tokens": today.Tokens,
			"cost_nano_usd": today.Cost, "errors": today.Errors,
		},
	}, nil
}

func (s Store) UsageReport(ctx context.Context, tenantID string, days int) (map[string]any, error) {
	if days < 1 || days > 365 {
		days = 30
	}
	since := time.Now().AddDate(0, 0, -days+1)
	since = time.Date(since.Year(), since.Month(), since.Day(), 0, 0, 0, 0, since.Location())
	base := scoped(ctx, s.DB).Model(&db.RequestLog{}).Where("started_at >= ?", since)
	if tenantID != "" {
		base = base.Where("tenant_id = ?", tenantID)
	}
	type summary struct {
		Requests int64 `json:"requests"`
		Errors   int64 `json:"errors"`
		Tokens   int64 `json:"tokens"`
		Cost     int64 `json:"cost_nano_usd"`
	}
	var total summary
	if err := base.Select(
		"count(*) AS requests, " +
			"COALESCE(sum(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END),0) AS errors, " +
			"COALESCE(sum(total_tokens),0) AS tokens, COALESCE(sum(cost_nano_usd),0) AS cost",
	).Scan(&total).Error; err != nil {
		return nil, err
	}
	type daily struct {
		Date     string `json:"date"`
		Requests int64  `json:"requests"`
		Errors   int64  `json:"errors"`
		Tokens   int64  `json:"tokens"`
		Cost     int64  `json:"cost_nano_usd"`
	}
	var dailyItems []daily
	dailyQuery := scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select(
			"to_char(started_at, 'YYYY-MM-DD') AS date, count(*) AS requests, "+
				"COALESCE(sum(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END),0) AS errors, "+
				"COALESCE(sum(total_tokens),0) AS tokens, COALESCE(sum(cost_nano_usd),0) AS cost",
		).Where("started_at >= ?", since)
	if tenantID != "" {
		dailyQuery = dailyQuery.Where("tenant_id = ?", tenantID)
	}
	if err := dailyQuery.Group("to_char(started_at, 'YYYY-MM-DD')").
		Order("date").Scan(&dailyItems).Error; err != nil {
		return nil, err
	}
	type modelTotal struct {
		Model    string `json:"model"`
		Requests int64  `json:"requests"`
		Tokens   int64  `json:"tokens"`
		Cost     int64  `json:"cost_nano_usd"`
	}
	var models []modelTotal
	modelQuery := scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select(
			"model, count(*) AS requests, COALESCE(sum(total_tokens),0) AS tokens, "+
				"COALESCE(sum(cost_nano_usd),0) AS cost",
		).Where("started_at >= ?", since)
	if tenantID != "" {
		modelQuery = modelQuery.Where("tenant_id = ?", tenantID)
	}
	if err := modelQuery.Group("model").Order("tokens DESC").Scan(&models).Error; err != nil {
		return nil, err
	}
	return map[string]any{
		"days": days, "user_id": tenantID, "summary": total,
		"daily": dailyItems, "models": models,
	}, nil
}
