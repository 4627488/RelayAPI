package store

import (
	"context"
	"errors"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/pricing"
)

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
	Model                           string   `json:"model"`
	Priced                          bool     `json:"priced"`
	PricedModel                     string   `json:"priced_model"`
	InputNanoUSDPerToken            int64    `json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64    `json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64    `json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64    `json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64    `json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64    `json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64    `json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64    `json:"image_output_nano_usd_per_token"`
	Source                          string   `json:"source"`
	Version                         string   `json:"version"`
	PriceMultiplier                 float64  `json:"price_multiplier"`
	DisplayName                     string   `json:"display_name,omitempty"`
	ContextWindow                   int      `json:"context_window,omitempty"`
	MaxOutputTokens                 int      `json:"max_output_tokens,omitempty"`
	ReasoningEfforts                []string `json:"reasoning_efforts,omitempty"`
	DefaultReasoningLevel           string   `json:"default_reasoning_level,omitempty"`
	InputModalities                 []string `json:"input_modalities,omitempty"`
	PreferWebSockets                *bool    `json:"prefer_websockets,omitempty"`
	CapabilitySource                string   `json:"capability_source,omitempty"`
	MaxInputTokens                  int      `json:"max_input_tokens,omitempty"`
	ToolCall                        *bool    `json:"tool_call,omitempty"`
	StructuredOutput                *bool    `json:"structured_output,omitempty"`
	Temperature                     *bool    `json:"temperature,omitempty"`
	OutputModalities                []string `json:"output_modalities,omitempty"`
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
		Where(generationLogSQL).
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
