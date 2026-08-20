package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/pricing"
	"github.com/lib/pq"
	"gorm.io/gorm/clause"
)

func (s Store) ListModelSettings(ctx context.Context) ([]db.ModelSetting, error) {
	result := make([]db.ModelSetting, 0)
	err := scoped(ctx, s.DB).Order("model").Find(&result).Error
	return result, err
}

func (s Store) GetModelSetting(ctx context.Context, model string) (db.ModelSetting, error) {
	var item db.ModelSetting
	err := scoped(ctx, s.DB).First(&item, "model = ?", strings.TrimSpace(model)).Error
	if err != nil {
		return db.ModelSetting{}, notFound(err)
	}
	return item, nil
}

func (s Store) UpsertModelSetting(ctx context.Context, item db.ModelSetting) (db.ModelSetting, error) {
	item.Model = strings.TrimSpace(item.Model)
	if item.Model == "" {
		return db.ModelSetting{}, fmt.Errorf("模型名不能为空")
	}
	item.DisplayName = strings.TrimSpace(item.DisplayName)
	item.DefaultReasoningLevel = strings.ToLower(strings.TrimSpace(item.DefaultReasoningLevel))
	item.Provider = strings.ToLower(strings.TrimSpace(item.Provider))
	item.ReasoningEfforts = cleanStringList(item.ReasoningEfforts)
	item.InputModalities = cleanStringList(item.InputModalities)
	if item.ContextWindow < 0 || item.MaxOutputTokens < 0 {
		return db.ModelSetting{}, fmt.Errorf("上下文和输出上限不能为负数")
	}
	item.UpdatedAt = time.Now()
	err := scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "model"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"display_name", "context_window", "max_output_tokens", "reasoning_efforts",
			"default_reasoning_level", "input_modalities", "prefer_web_sockets", "provider", "updated_at",
		}),
	}).Create(&item).Error
	if err != nil {
		return db.ModelSetting{}, err
	}
	return s.GetModelSetting(ctx, item.Model)
}

func (s Store) DeleteModelSetting(ctx context.Context, model string) error {
	result := scoped(ctx, s.DB).Delete(&db.ModelSetting{}, "model = ?", strings.TrimSpace(model))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func ModelSettingCapability(item db.ModelSetting) pricing.Capability {
	efforts := append([]string(nil), item.ReasoningEfforts...)
	options := []pricing.ReasoningOption(nil)
	if len(efforts) > 0 {
		options = []pricing.ReasoningOption{{Type: "effort", Values: efforts}}
	}
	provider := strings.TrimSpace(item.Provider)
	if provider == "" {
		provider = inferredCapabilityProvider(item.Model)
	}
	reasoning := false
	for _, effort := range efforts {
		if effort != "none" {
			reasoning = true
			break
		}
	}
	return pricing.Capability{
		ID:               item.Model,
		Name:             item.DisplayName,
		Provider:         provider,
		Source:           pricing.SourceAdmin,
		Context:          item.ContextWindow,
		MaxOutput:        item.MaxOutputTokens,
		Reasoning:        reasoning,
		ReasoningOptions: options,
		DefaultLevel:     item.DefaultReasoningLevel,
		InputModalities:  append([]string(nil), item.InputModalities...),
		PreferWebSockets: item.PreferWebSockets,
	}
}

func inferredCapabilityProvider(model string) string {
	lower := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.HasPrefix(lower, "kimi-"):
		return "moonshotai"
	case strings.HasPrefix(lower, "deepseek-"):
		return "deepseek"
	case strings.HasPrefix(lower, "grok-"):
		return "xai"
	case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "o1-"),
		strings.HasPrefix(lower, "o3-"), strings.HasPrefix(lower, "o4-"),
		strings.HasPrefix(lower, "codex-"):
		return "openai"
	default:
		return ""
	}
}

func cleanStringList(values []string) pq.StringArray {
	result := make(pq.StringArray, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
