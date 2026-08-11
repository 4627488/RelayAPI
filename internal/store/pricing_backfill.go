package store

import (
	"context"
	"errors"
	"strings"
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
	Model                           string    `json:"model"`
	RequestCount                    int64     `json:"request_count"`
	LatestStartedAt                 time.Time `json:"latest_started_at"`
	Priced                          bool      `json:"priced"`
	PricedModel                     string    `json:"priced_model"`
	InputNanoUSDPerToken            int64     `json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64     `json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64     `json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64     `json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64     `json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64     `json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64     `json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64     `json:"image_output_nano_usd_per_token"`
	Source                          string    `json:"source"`
	Version                         string    `json:"version"`
	PriceMultiplier                 float64   `json:"price_multiplier"`
}

type AvailableModelPrice struct {
	Model                           string  `json:"model"`
	Priced                          bool    `json:"priced"`
	PricedModel                     string  `json:"priced_model"`
	InputNanoUSDPerToken            int64   `json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64   `json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64   `json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64   `json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64   `json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64   `json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64   `json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64   `json:"image_output_nano_usd_per_token"`
	Source                          string  `json:"source"`
	Version                         string  `json:"version"`
	PriceMultiplier                 float64 `json:"price_multiplier"`
}

func (s *Store) AvailableModelPrices(ctx context.Context, models []string) ([]AvailableModelPrice, error) {
	result := make([]AvailableModelPrice, 0, len(models))
	for _, model := range models {
		item := AvailableModelPrice{Model: model}
		resolved, err := s.ResolvePrice(ctx, pricing.Dimensions{Model: model})
		if errors.Is(err, ErrNotFound) {
			result = append(result, item)
			continue
		}
		if err != nil {
			return nil, err
		}
		item.Priced = true
		item.PricedModel = resolved.PricedModel
		item.InputNanoUSDPerToken = resolved.InputNanoUSDPerToken
		item.OutputNanoUSDPerToken = resolved.OutputNanoUSDPerToken
		item.CachedInputNanoUSDPerToken = resolved.CachedInputNanoUSDPerToken
		item.CacheWriteNanoUSDPerToken = resolved.CacheWriteNanoUSDPerToken
		item.ReasoningNanoUSDPerToken = resolved.ReasoningNanoUSDPerToken
		item.ImageInputNanoUSDPerToken = resolved.ImageInputNanoUSDPerToken
		item.CachedImageInputNanoUSDPerToken = resolved.CachedImageInputNanoUSDPerToken
		item.ImageOutputNanoUSDPerToken = resolved.ImageOutputNanoUSDPerToken
		item.Source = resolved.Source
		item.Version = resolved.Version
		item.PriceMultiplier = resolved.PriceMultiplier
		result = append(result, item)
	}
	return result, nil
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
		result[index].ImageInputNanoUSDPerToken = resolved.ImageInputNanoUSDPerToken
		result[index].CachedImageInputNanoUSDPerToken = resolved.CachedImageInputNanoUSDPerToken
		result[index].ImageOutputNanoUSDPerToken = resolved.ImageOutputNanoUSDPerToken
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
			imageOutput := item.ImageOutputTokens
			if imageOutput == 0 && strings.HasPrefix(item.Path, "/v1/images/") && price.ImageOutputNanoUSDPerToken > 0 {
				// Logs written before modality-aware accounting only retained the
				// aggregate completion count. Images API completion tokens are image
				// output tokens, so they can still be reconciled without estimation.
				imageOutput = item.CompletionTokens
			}
			cost := pricing.CostNanoUSD(price, pricing.Usage{
				Prompt: item.PromptTokens, Completion: item.CompletionTokens, Cached: item.CachedTokens,
				CacheWrite: item.CacheWriteTokens, Reasoning: item.ReasoningTokens, Total: item.TotalTokens,
				ImageInput: item.ImageInputTokens, CachedImageInput: item.CachedImageInputTokens, ImageOutput: imageOutput,
			})
			if err := tx.Model(&db.RequestLog{}).Where("id = ? AND pricing_complete = ?", item.ID, false).
				Updates(map[string]any{
					"cost_nano_usd": cost, "price_model": price.PricedModel,
					"price_source": price.Source, "price_version": price.Version,
					"input_price_nano_usd":              price.InputNanoUSDPerToken,
					"output_price_nano_usd":             price.OutputNanoUSDPerToken,
					"cached_price_nano_usd":             price.CachedInputNanoUSDPerToken,
					"cache_write_price_nano_usd":        price.CacheWriteNanoUSDPerToken,
					"reasoning_price_nano_usd":          price.ReasoningNanoUSDPerToken,
					"image_input_price_nano_usd":        price.ImageInputNanoUSDPerToken,
					"cached_image_input_price_nano_usd": price.CachedImageInputNanoUSDPerToken,
					"image_output_price_nano_usd":       price.ImageOutputNanoUSDPerToken,
					"image_output_tokens":               imageOutput,
					"price_multiplier":                  price.PriceMultiplier, "pricing_complete": true,
				}).Error; err != nil {
				return err
			}
			if item.ReservationRequestID == nil {
				if err := reconcileSettledReservation(tx, item.ID, cost); err != nil {
					return err
				}
			} else {
				var pending int64
				if err := tx.Model(&db.RequestLog{}).
					Where("reservation_request_id = ? AND pricing_complete = ?", *item.ReservationRequestID, false).
					Count(&pending).Error; err != nil {
					return err
				}
				if pending == 0 {
					var aggregate int64
					if err := tx.Model(&db.RequestLog{}).
						Select("COALESCE(sum(cost_nano_usd), 0)").
						Where("reservation_request_id = ?", *item.ReservationRequestID).
						Scan(&aggregate).Error; err != nil {
						return err
					}
					if err := reconcileSettledReservation(tx, *item.ReservationRequestID, aggregate); err != nil {
						return err
					}
				}
			}
			updated++
		}
		return nil
	})
	return updated, err
}
