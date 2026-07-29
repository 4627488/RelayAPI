package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/pricing"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	DB             *gorm.DB
	pricingCatalog *pricing.Catalog
	pricingMu      *sync.Mutex
}
type Tenant = db.Tenant
type APIKey = db.APIKey
type Price = db.ModelPrice
type ResolvedPrice = pricing.SnapshotPrice
type Invitation = db.Invitation

func New(database *gorm.DB) (Store, error) {
	s := Store{DB: database, pricingCatalog: pricing.NewCatalog(nil), pricingMu: &sync.Mutex{}}
	if err := s.RefreshPricing(context.Background()); err != nil {
		return Store{}, err
	}
	return s, nil
}

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
	ID, TenantID, APIKeyID, CPARequestID, Model, Provider, AuthIndex, ParentSubscriptionID, ChildSubscriptionID, Method, Path string
	CPATraceID, CPAExecutionID, RequestedModel, ActualModel, ModelAlias, ExecutorType, AuthType                               string
	ServiceTier, ResponseServiceTier, ReasoningEffort, TenantName, APIKeyName, APIKeyPrefix, RequestType                      string
	StatusCode                                                                                                                int
	Stream, PricingComplete, Settled                                                                                          bool
	Usage                                                                                                                     Usage
	CostNanoUSD                                                                                                               *int64
	Price                                                                                                                     *ResolvedPrice
	ReservedNanoUSD, LatencyMS                                                                                                int64
	TTFTMS                                                                                                                    *int64
	ErrorCode, ErrorMessage                                                                                                   string
	StartedAt, CompletedAt                                                                                                    time.Time
	Detail                                                                                                                    *LogDetailInput
}

type LogDetailInput struct {
	RequestHeaders, RequestBody, ForwardedHeaders, ForwardedBody, UpstreamHeaders, UpstreamBody string
	RequestBodyTruncated, ForwardedBodyTruncated, UpstreamBodyTruncated                         bool
	RequestBodyBytes, ForwardedBodyBytes, UpstreamBodyBytes                                     int64
	UpstreamStatus                                                                              int
	ErrorName, ErrorMessage, ErrorStack, ErrorCause, ErrorDetail, StageTimings                  string
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

func (s Store) SetupRequired(ctx context.Context) (bool, error) {
	var count int64
	err := scoped(ctx, s.DB).Model(&Tenant{}).Count(&count).Error
	return count == 0, err
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

func (s *Store) Price(ctx context.Context, model string) (ResolvedPrice, error) {
	return s.ResolvePrice(ctx, pricing.Dimensions{Model: model})
}

func (s *Store) ResolvePrice(ctx context.Context, dimensions pricing.Dimensions) (ResolvedPrice, error) {
	if s.pricingCatalog == nil || s.pricingCatalog.Snapshot() == nil {
		if err := s.RefreshPricing(ctx); err != nil {
			return ResolvedPrice{}, err
		}
	}
	if value, ok := s.pricingCatalog.Snapshot().Resolve(dimensions); ok {
		return value, nil
	}
	return ResolvedPrice{}, ErrNotFound
}

func (s Store) ListPrices(ctx context.Context) ([]Price, error) {
	var result []Price
	err := scoped(ctx, s.DB).Order("model").Find(&result).Error
	return result, err
}

func (s Store) AdminPrice(ctx context.Context, model string) (Price, error) {
	var result Price
	err := scoped(ctx, s.DB).First(&result, "model = ?", strings.TrimSpace(model)).Error
	if err != nil {
		return Price{}, notFound(err)
	}
	return result, nil
}

func (s *Store) UpsertPrice(ctx context.Context, price Price) error {
	price.Source = "admin"
	price.Version = "admin:" + time.Now().UTC().Format(time.RFC3339Nano)
	// Explicit zero remains supported as a free-model override. JSON clients
	// that omit the field are normalized by the API to one.
	err := scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "model"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"input_nano_usd_per_token", "output_nano_usd_per_token", "cached_input_nano_usd_per_token",
			"cache_write_nano_usd_per_token", "reasoning_nano_usd_per_token", "source", "version",
			"price_multiplier", "updated_at",
		}),
	}).Create(&price).Error
	if err == nil {
		err = s.RefreshPricing(ctx)
	}
	return err
}

func (s *Store) DeletePrice(ctx context.Context, model string) error {
	result := scoped(ctx, s.DB).Delete(&db.ModelPrice{}, "model = ?", strings.TrimSpace(model))
	if result.Error != nil {
		return result.Error
	}
	if err := s.RefreshPricing(ctx); err != nil {
		return err
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s Store) ListCatalogPrices(ctx context.Context) ([]db.ModelCatalogPrice, error) {
	var result []db.ModelCatalogPrice
	err := scoped(ctx, s.DB).Order("model").Find(&result).Error
	return result, err
}

func (s Store) ListModelAliases(ctx context.Context) ([]db.ModelAlias, error) {
	var result []db.ModelAlias
	err := scoped(ctx, s.DB).Order("alias").Find(&result).Error
	return result, err
}

func (s *Store) ReplaceModelAliases(ctx context.Context, aliases []db.ModelAlias) error {
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&db.ModelAlias{}).Error; err != nil {
			return err
		}
		if len(aliases) == 0 {
			return nil
		}
		now := time.Now()
		for index := range aliases {
			aliases[index].Alias = strings.TrimSpace(aliases[index].Alias)
			aliases[index].Model = strings.TrimSpace(aliases[index].Model)
			aliases[index].UpdatedAt = now
			if aliases[index].Alias == "" || aliases[index].Model == "" {
				return errors.New("alias and model are required")
			}
		}
		return tx.Create(&aliases).Error
	})
	if err == nil {
		err = s.RefreshPricing(ctx)
	}
	return err
}

func (s Store) ListPriceRules(ctx context.Context) ([]db.ModelPriceRule, error) {
	var result []db.ModelPriceRule
	err := scoped(ctx, s.DB).Order("model, field, value").Find(&result).Error
	return result, err
}

func (s *Store) ReplacePriceRules(ctx context.Context, rules []db.ModelPriceRule) error {
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&db.ModelPriceRule{}).Error; err != nil {
			return err
		}
		now := time.Now()
		for index := range rules {
			rules[index].ID = identity.NewID()
			rules[index].Model = strings.TrimSpace(rules[index].Model)
			rules[index].Field = strings.ToLower(strings.TrimSpace(rules[index].Field))
			rules[index].Value = strings.TrimSpace(rules[index].Value)
			rules[index].CreatedAt, rules[index].UpdatedAt = now, now
			if rules[index].Model == "" || rules[index].Value == "" || !pricing.ValidRuleField(rules[index].Field) ||
				rules[index].Multiplier < 0 || math.IsNaN(rules[index].Multiplier) || math.IsInf(rules[index].Multiplier, 0) {
				return errors.New("invalid pricing rule")
			}
		}
		if len(rules) == 0 {
			return nil
		}
		return tx.Create(&rules).Error
	})
	if err == nil {
		err = s.RefreshPricing(ctx)
	}
	return err
}

func (s *Store) ApplyCatalog(ctx context.Context, result pricing.SyncResult) error {
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&db.ModelCatalogPrice{}).Error; err != nil {
			return err
		}
		rows := make([]db.ModelCatalogPrice, 0, len(result.Entries))
		now := time.Now()
		for _, entry := range result.Entries {
			rows = append(rows, db.ModelCatalogPrice{
				Model: entry.Model, InputNanoUSDPerToken: entry.InputNanoUSDPerToken,
				OutputNanoUSDPerToken:      entry.OutputNanoUSDPerToken,
				CachedInputNanoUSDPerToken: entry.CachedInputNanoUSDPerToken,
				CacheWriteNanoUSDPerToken:  entry.CacheWriteNanoUSDPerToken,
				ReasoningNanoUSDPerToken:   entry.ReasoningNanoUSDPerToken,
				Source:                     result.Source, Version: result.Version, SourceModelID: entry.SourceModelID,
				RawJSON: entry.RawJSON, UpdatedAt: now,
			})
		}
		for start := 0; start < len(rows); start += 500 {
			end := min(start+500, len(rows))
			if err := tx.Create(rows[start:end]).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		err = s.RefreshPricing(ctx)
	}
	return err
}

func (s *Store) RefreshPricing(ctx context.Context) error {
	if s.pricingCatalog == nil {
		s.pricingCatalog = pricing.NewCatalog(nil)
	}
	if s.pricingMu == nil {
		s.pricingMu = &sync.Mutex{}
	}
	s.pricingMu.Lock()
	defer s.pricingMu.Unlock()
	var admin []db.ModelPrice
	var catalog []db.ModelCatalogPrice
	var aliases []db.ModelAlias
	var rules []db.ModelPriceRule
	if err := scoped(ctx, s.DB).Find(&admin).Error; err != nil {
		return err
	}
	if err := scoped(ctx, s.DB).Find(&catalog).Error; err != nil {
		return err
	}
	if err := scoped(ctx, s.DB).Find(&aliases).Error; err != nil {
		return err
	}
	if err := scoped(ctx, s.DB).Find(&rules).Error; err != nil {
		return err
	}
	adminPrices := make([]pricing.Price, 0, len(admin))
	for _, value := range admin {
		multiplier := value.PriceMultiplier
		if multiplier == 0 && value.UpdatedAt.IsZero() {
			multiplier = 1
		}
		adminPrices = append(adminPrices, pricing.Price{
			Model: value.Model, InputNanoUSDPerToken: value.InputNanoUSDPerToken,
			OutputNanoUSDPerToken:      value.OutputNanoUSDPerToken,
			CachedInputNanoUSDPerToken: value.CachedInputNanoUSDPerToken,
			CacheWriteNanoUSDPerToken:  value.CacheWriteNanoUSDPerToken,
			ReasoningNanoUSDPerToken:   value.ReasoningNanoUSDPerToken,
			Source:                     pricing.SourceAdmin, Version: value.Version, PriceMultiplier: multiplier,
		})
	}
	catalogPrices := make([]pricing.Price, 0, len(catalog))
	for _, value := range catalog {
		catalogPrices = append(catalogPrices, pricing.Price{
			Model: value.Model, InputNanoUSDPerToken: value.InputNanoUSDPerToken,
			OutputNanoUSDPerToken:      value.OutputNanoUSDPerToken,
			CachedInputNanoUSDPerToken: value.CachedInputNanoUSDPerToken,
			CacheWriteNanoUSDPerToken:  value.CacheWriteNanoUSDPerToken,
			ReasoningNanoUSDPerToken:   value.ReasoningNanoUSDPerToken,
			Source:                     value.Source, Version: value.Version, PriceMultiplier: 1,
		})
	}
	aliasMap := make(map[string]string, len(aliases))
	for _, value := range aliases {
		aliasMap[value.Alias] = value.Model
	}
	priceRules := make([]pricing.Rule, 0, len(rules))
	for _, value := range rules {
		priceRules = append(priceRules, pricing.Rule{
			Model: value.Model, Field: value.Field, Value: value.Value, Multiplier: value.Multiplier,
		})
	}
	snapshot, err := pricing.Compile(adminPrices, catalogPrices, pricing.BundledPrices, aliasMap, priceRules)
	if err != nil {
		return err
	}
	s.pricingCatalog.Replace(snapshot)
	_, err = s.backfillPendingPricing(ctx)
	return err
}

func EncodePriceSnapshot(price ResolvedPrice) []byte {
	raw, _ := json.Marshal(price)
	return raw
}

func nullableIdentifier(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func (s Store) WriteLog(ctx context.Context, l LogInput) error {
	item := db.RequestLog{
		ID: l.ID, TenantID: l.TenantID, APIKeyID: l.APIKeyID, CPARequestID: l.CPARequestID,
		CPATraceID: l.CPATraceID, CPAExecutionID: l.CPAExecutionID,
		Model: l.Model, RequestedModel: l.RequestedModel, ActualModel: l.ActualModel, ModelAlias: l.ModelAlias,
		Provider: l.Provider, ExecutorType: l.ExecutorType, AuthType: l.AuthType, AuthIndex: l.AuthIndex,
		ServiceTier: l.ServiceTier, ResponseServiceTier: l.ResponseServiceTier, ReasoningEffort: l.ReasoningEffort,
		ParentSubscriptionID: nullableIdentifier(l.ParentSubscriptionID),
		ChildSubscriptionID:  nullableIdentifier(l.ChildSubscriptionID),
		TenantName:           l.TenantName, APIKeyName: l.APIKeyName, APIKeyPrefix: l.APIKeyPrefix,
		Method: l.Method, Path: l.Path, RequestType: l.RequestType, StatusCode: l.StatusCode,
		Stream: l.Stream, PromptTokens: l.Usage.Prompt, CompletionTokens: l.Usage.Completion,
		CachedTokens: l.Usage.Cached, CacheWriteTokens: l.Usage.CacheWrite, ReasoningTokens: l.Usage.Reasoning,
		TotalTokens: l.Usage.Total, CostNanoUSD: l.CostNanoUSD, PricingComplete: l.PricingComplete,
		Settled: l.Settled, ReservedNanoUSD: l.ReservedNanoUSD, LatencyMS: l.LatencyMS, TTFTMS: l.TTFTMS,
		ErrorCode: l.ErrorCode, ErrorMessage: l.ErrorMessage, StartedAt: l.StartedAt, CompletedAt: l.CompletedAt,
	}
	if l.Price != nil {
		item.PriceModel = l.Price.PricedModel
		item.PriceSource = l.Price.Source
		item.PriceVersion = l.Price.Version
		item.InputPriceNanoUSD = l.Price.InputNanoUSDPerToken
		item.OutputPriceNanoUSD = l.Price.OutputNanoUSDPerToken
		item.CachedPriceNanoUSD = l.Price.CachedInputNanoUSDPerToken
		item.CacheWritePriceNanoUSD = l.Price.CacheWriteNanoUSDPerToken
		item.ReasoningPriceNanoUSD = l.Price.ReasoningNanoUSDPerToken
		item.PriceMultiplier = l.Price.PriceMultiplier
	}
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		if item.ParentSubscriptionID != nil {
			var parent db.ParentSubscription
			if err := tx.First(&parent, "id = ?", *item.ParentSubscriptionID).Error; err == nil {
				item.ParentSubscriptionName = parent.Name
				item.ChannelID, item.ChannelName = parent.ID, parent.Name
				item.CredentialID, item.CredentialName = parent.CPAAuthID, parent.CPAAuthName
				if item.Provider == "" {
					item.Provider = parent.Provider
				}
				var metadata map[string]any
				if json.Unmarshal(parent.Metadata, &metadata) == nil {
					for _, key := range []string{"email", "account_email", "user_email"} {
						if value, ok := metadata[key].(string); ok && strings.TrimSpace(value) != "" {
							item.CredentialEmail = strings.TrimSpace(value)
							break
						}
					}
				}
			}
		}
		if item.ChildSubscriptionID != nil {
			var child db.ChildSubscription
			if err := tx.First(&child, "id = ?", *item.ChildSubscriptionID).Error; err == nil {
				item.ChildSubscriptionName = child.Name
			}
		}
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		if l.Detail != nil {
			detail := db.RequestLogDetail{
				RequestLogID: l.ID, RequestHeaders: l.Detail.RequestHeaders, RequestBody: l.Detail.RequestBody,
				RequestBodyTruncated: l.Detail.RequestBodyTruncated, RequestBodyBytes: l.Detail.RequestBodyBytes,
				ForwardedHeaders: l.Detail.ForwardedHeaders, ForwardedBody: l.Detail.ForwardedBody,
				ForwardedBodyTruncated: l.Detail.ForwardedBodyTruncated, ForwardedBodyBytes: l.Detail.ForwardedBodyBytes,
				UpstreamStatus: l.Detail.UpstreamStatus, UpstreamHeaders: l.Detail.UpstreamHeaders,
				UpstreamBody: l.Detail.UpstreamBody, UpstreamBodyTruncated: l.Detail.UpstreamBodyTruncated,
				UpstreamBodyBytes: l.Detail.UpstreamBodyBytes, ErrorName: l.Detail.ErrorName,
				ErrorMessage: l.Detail.ErrorMessage, ErrorStack: l.Detail.ErrorStack, ErrorCause: l.Detail.ErrorCause,
				ErrorDetail: l.Detail.ErrorDetail, StageTimings: l.Detail.StageTimings,
			}
			if err := tx.Create(&detail).Error; err != nil {
				return err
			}
		}
		return applyPendingCPALifecycleEvents(tx, l.ID)
	})
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

type LogQuery struct {
	TenantID     string
	Page         int
	PageSize     int
	Query        string
	Status       string
	Method       string
	Model        string
	From         *time.Time
	To           *time.Time
	MinLatencyMS int64
}

type LogSummary struct {
	Requests       int64   `json:"requests"`
	Errors         int64   `json:"errors"`
	Tokens         int64   `json:"tokens"`
	CachedTokens   int64   `json:"cached_tokens"`
	CostNanoUSD    int64   `json:"cost_nano_usd"`
	AverageLatency float64 `json:"average_latency_ms"`
}

type LogPage struct {
	Items    []db.RequestLog `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
	Total    int64           `json:"total"`
	Summary  LogSummary      `json:"summary"`
}

func (s Store) QueryLogs(ctx context.Context, input LogQuery) (LogPage, error) {
	if input.Page < 1 {
		input.Page = 1
	}
	if input.PageSize < 1 || input.PageSize > 200 {
		input.PageSize = 50
	}
	query := scoped(ctx, s.DB).Model(&db.RequestLog{})
	if input.TenantID != "" {
		query = query.Where("tenant_id = ?", input.TenantID)
	}
	if text := strings.TrimSpace(input.Query); text != "" {
		like := "%" + text + "%"
		query = query.Where(
			"model ILIKE ? OR requested_model ILIKE ? OR actual_model ILIKE ? OR path ILIKE ? OR tenant_name ILIKE ? OR api_key_name ILIKE ? OR channel_name ILIKE ? OR credential_name ILIKE ? OR credential_email ILIKE ? OR error_message ILIKE ? OR cpa_trace_id ILIKE ?",
			like, like, like, like, like, like, like, like, like, like, like,
		)
	}
	switch input.Status {
	case "success":
		query = query.Where("status_code >= 200 AND status_code < 400")
	case "error":
		query = query.Where("status_code = 0 OR status_code >= 400")
	case "stream":
		query = query.Where("stream = ?", true)
	}
	if input.Method != "" {
		query = query.Where("method = ?", strings.ToUpper(input.Method))
	}
	if input.Model != "" {
		query = query.Where("(model = ? OR requested_model = ? OR actual_model = ?)", input.Model, input.Model, input.Model)
	}
	if input.From != nil {
		query = query.Where("started_at >= ?", *input.From)
	}
	if input.To != nil {
		query = query.Where("started_at <= ?", *input.To)
	}
	if input.MinLatencyMS > 0 {
		query = query.Where("latency_ms >= ?", input.MinLatencyMS)
	}
	countQuery := query.Session(&gorm.Session{})
	summaryQuery := query.Session(&gorm.Session{})
	itemsQuery := query.Session(&gorm.Session{})
	var total int64
	if err := countQuery.Count(&total).Error; err != nil {
		return LogPage{}, err
	}
	var summary LogSummary
	if err := summaryQuery.Select(
		"count(*) AS requests, COALESCE(sum(CASE WHEN status_code = 0 OR status_code >= 400 THEN 1 ELSE 0 END),0) AS errors, " +
			"COALESCE(sum(total_tokens),0) AS tokens, COALESCE(sum(cached_tokens),0) AS cached_tokens, " +
			"COALESCE(sum(cost_nano_usd),0) AS cost_nano_usd, COALESCE(avg(latency_ms),0) AS average_latency",
	).Scan(&summary).Error; err != nil {
		return LogPage{}, err
	}
	var items []db.RequestLog
	if err := itemsQuery.Order("started_at DESC").Offset((input.Page - 1) * input.PageSize).Limit(input.PageSize).Find(&items).Error; err != nil {
		return LogPage{}, err
	}
	return LogPage{Items: items, Page: input.Page, PageSize: input.PageSize, Total: total, Summary: summary}, nil
}

type LogWithDetail struct {
	Log    db.RequestLog        `json:"log"`
	Detail *db.RequestLogDetail `json:"detail"`
}

func (s Store) RequestLogDetail(ctx context.Context, id, tenantID string) (LogWithDetail, error) {
	var item db.RequestLog
	query := scoped(ctx, s.DB).Where("id = ?", id)
	if tenantID != "" {
		query = query.Where("tenant_id = ?", tenantID)
	}
	if err := query.First(&item).Error; err != nil {
		return LogWithDetail{}, notFound(err)
	}
	var detail db.RequestLogDetail
	err := scoped(ctx, s.DB).First(&detail, "request_log_id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return LogWithDetail{Log: item}, nil
	}
	if err != nil {
		return LogWithDetail{}, err
	}
	return LogWithDetail{Log: item, Detail: &detail}, nil
}

func (s Store) PruneRequestLogs(ctx context.Context, now time.Time, summaryDays, detailDays int) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		if detailDays > 0 {
			detailCutoff := now.AddDate(0, 0, -detailDays)
			subquery := tx.Model(&db.RequestLog{}).Select("id").Where("completed_at < ?", detailCutoff)
			if err := tx.Where("request_log_id IN (?)", subquery).Delete(&db.RequestLogDetail{}).Error; err != nil {
				return err
			}
		}
		eventCutoff := now.AddDate(0, 0, -7)
		if err := tx.Where("created_at < ?", eventCutoff).Delete(&db.CPALifecycleEvent{}).Error; err != nil {
			return err
		}
		if summaryDays > 0 {
			summaryCutoff := now.AddDate(0, 0, -summaryDays)
			subquery := tx.Model(&db.RequestLog{}).Select("id").Where("completed_at < ?", summaryCutoff)
			if err := tx.Where("request_log_id IN (?)", subquery).Delete(&db.RequestLogDetail{}).Error; err != nil {
				return err
			}
			if err := tx.Where("request_log_id IN (?)", subquery).Delete(&db.CPALifecycleEvent{}).Error; err != nil {
				return err
			}
			if err := tx.Where("completed_at < ?", summaryCutoff).Delete(&db.RequestLog{}).Error; err != nil {
				return err
			}
		}
		return nil
	})
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

func (s Store) Register(ctx context.Context, token, name, email, password string) (Tenant, error) {
	token = strings.TrimSpace(token)
	email = strings.ToLower(strings.TrimSpace(email))
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return Tenant{}, err
	}
	var user Tenant
	err = scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		// Serialize the empty-database check so two simultaneous setup requests
		// cannot both become the first administrator.
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(?)`, int64(0x52656c6179415049)).Error; err != nil {
			return err
		}
		var userCount int64
		if err := tx.Model(&Tenant{}).Count(&userCount).Error; err != nil {
			return err
		}
		if userCount == 0 {
			user = Tenant{
				ID: identity.NewID(), Name: strings.TrimSpace(name), OwnerEmail: email,
				PasswordHash: string(passwordHash), Enabled: true, IsAdmin: true,
			}
			return tx.Create(&user).Error
		}
		if token == "" {
			return ErrNotFound
		}
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
			PasswordHash: string(passwordHash), Enabled: true, IsAdmin: false,
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
	dailyItems := make([]daily, 0)
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
	models := make([]modelTotal, 0)
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
