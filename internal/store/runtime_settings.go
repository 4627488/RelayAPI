package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"gorm.io/gorm/clause"
)

func runtimeSettingAssociatedData(key string) string {
	return "relayapi/runtime-setting/v1/" + key
}

func (s Store) GetRuntimeSetting(ctx context.Context, key string, output any) (bool, error) {
	key = strings.TrimSpace(key)
	var item db.RuntimeSetting
	if err := scoped(ctx, s.DB).First(&item, "key = ?", key).Error; err != nil {
		if notFound(err) == ErrNotFound {
			return false, nil
		}
		return false, err
	}
	document, err := s.secretBox.Open(item.SealedDocument, runtimeSettingAssociatedData(key))
	if err != nil {
		return false, err
	}
	if err = json.Unmarshal(document, output); err != nil {
		return false, fmt.Errorf("decode runtime setting %q: %w", key, err)
	}
	return true, nil
}

func (s Store) PutRuntimeSetting(ctx context.Context, key string, value any) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("runtime setting key is required")
	}
	document, err := json.Marshal(value)
	if err != nil {
		return err
	}
	sealed, err := s.secretBox.Seal(document, runtimeSettingAssociatedData(key))
	if err != nil {
		return err
	}
	item := db.RuntimeSetting{Key: key, SealedDocument: sealed, UpdatedAt: time.Now().UTC()}
	return scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.Assignments(map[string]any{"sealed_document": sealed, "updated_at": item.UpdatedAt}),
	}).Create(&item).Error
}
