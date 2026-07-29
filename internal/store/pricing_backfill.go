package store

import (
	"context"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/pricing"
	"gorm.io/gorm"
)

type PendingPriceModel struct {
	Model           string `json:"model"`
	RequestCount    int64  `json:"request_count"`
	LatestStartedAt string `json:"latest_started_at"`
}

func (s *Store) PendingPricing(ctx context.Context) ([]PendingPriceModel, error) {
	var result []PendingPriceModel
	err := scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select("model, count(*) AS request_count, max(started_at)::text AS latest_started_at").
		Where("pricing_complete = ? AND model <> '' AND status_code >= 200 AND status_code < 400", false).
		Group("model").Order("request_count DESC, model").Scan(&result).Error
	return result, err
}

func (s *Store) backfillPendingPricing(ctx context.Context) (int, error) {
	if s.pricingCatalog == nil || s.pricingCatalog.Snapshot() == nil {
		return 0, nil
	}
	var logs []db.RequestLog
	if err := scoped(ctx, s.DB).
		Where("pricing_complete = ? AND model <> '' AND status_code >= 200 AND status_code < 400", false).
		Find(&logs).Error; err != nil {
		return 0, err
	}
	updated := 0
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		for _, item := range logs {
			price, ok := s.pricingCatalog.Snapshot().Resolve(pricing.Dimensions{
				APIGroupKey: item.APIKeyID, Model: item.Model, ModelAlias: item.ModelAlias,
				AuthIndex: item.AuthIndex, ServiceTier: item.ServiceTier,
				ResponseServiceTier: item.ResponseServiceTier, ReasoningEffort: item.ReasoningEffort,
				Endpoint: item.Path, ExecutorType: item.ExecutorType,
			})
			if !ok {
				continue
			}
			uncached := item.PromptTokens - item.CachedTokens
			if uncached < 0 {
				uncached = 0
			}
			cost := uncached*price.InputNanoUSDPerToken +
				item.CachedTokens*price.CachedInputNanoUSDPerToken +
				item.CompletionTokens*price.OutputNanoUSDPerToken +
				item.CacheWriteTokens*price.CacheWriteNanoUSDPerToken +
				item.ReasoningTokens*price.ReasoningNanoUSDPerToken
			if err := tx.Model(&db.RequestLog{}).Where("id = ? AND pricing_complete = ?", item.ID, false).
				Updates(map[string]any{
					"cost_nano_usd": cost, "price_model": price.PricedModel,
					"price_source": price.Source, "price_version": price.Version,
					"input_price_nano_usd":       price.InputNanoUSDPerToken,
					"output_price_nano_usd":      price.OutputNanoUSDPerToken,
					"cached_price_nano_usd":      price.CachedInputNanoUSDPerToken,
					"cache_write_price_nano_usd": price.CacheWriteNanoUSDPerToken,
					"reasoning_price_nano_usd":   price.ReasoningNanoUSDPerToken,
					"price_multiplier":           price.PriceMultiplier, "pricing_complete": true,
				}).Error; err != nil {
				return err
			}
			updated++
		}
		return nil
	})
	return updated, err
}
