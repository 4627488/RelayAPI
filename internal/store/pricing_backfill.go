package store

import (
	"context"
	"errors"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/pricing"
	"gorm.io/gorm"
)

type PendingPriceModel struct {
	Model           string `json:"model"`
	RequestCount    int64  `json:"request_count"`
	LatestStartedAt string `json:"latest_started_at"`
}

type HistoricalModelPrice struct {
	Model                      string    `json:"model"`
	RequestCount               int64     `json:"request_count"`
	LatestStartedAt            time.Time `json:"latest_started_at"`
	Priced                     bool      `json:"priced"`
	PricedModel                string    `json:"priced_model"`
	InputNanoUSDPerToken       int64     `json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken      int64     `json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken int64     `json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken  int64     `json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken   int64     `json:"reasoning_nano_usd_per_token"`
	Source                     string    `json:"source"`
	Version                    string    `json:"version"`
	PriceMultiplier            float64   `json:"price_multiplier"`
}

func (s *Store) HistoricalModelPrices(ctx context.Context) ([]HistoricalModelPrice, error) {
	result := make([]HistoricalModelPrice, 0)
	if err := scoped(ctx, s.DB).Model(&db.RequestLog{}).
		Select("model, count(*) AS request_count, max(started_at) AS latest_started_at").
		Where("model <> ''").
		Group("model").Order("latest_started_at DESC, model").
		Scan(&result).Error; err != nil {
		return nil, err
	}
	for index := range result {
		resolved, err := s.ResolvePrice(ctx, pricing.Dimensions{Model: result[index].Model})
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result[index].Priced = true
		result[index].PricedModel = resolved.PricedModel
		result[index].InputNanoUSDPerToken = resolved.InputNanoUSDPerToken
		result[index].OutputNanoUSDPerToken = resolved.OutputNanoUSDPerToken
		result[index].CachedInputNanoUSDPerToken = resolved.CachedInputNanoUSDPerToken
		result[index].CacheWriteNanoUSDPerToken = resolved.CacheWriteNanoUSDPerToken
		result[index].ReasoningNanoUSDPerToken = resolved.ReasoningNanoUSDPerToken
		result[index].Source = resolved.Source
		result[index].Version = resolved.Version
		result[index].PriceMultiplier = resolved.PriceMultiplier
	}
	return result, nil
}

func (s *Store) PendingPricing(ctx context.Context) ([]PendingPriceModel, error) {
	result := make([]PendingPriceModel, 0)
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
