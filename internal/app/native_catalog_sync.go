package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
)

func (a *App) persistExpandedCredentialModels(ctx context.Context) error {
	if a == nil || a.nativeRuntime == nil || a.store.DB == nil {
		return nil
	}
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		provider := strings.ToLower(strings.TrimSpace(row.Provider))
		if _, supported := normalizeSupportedProvider(provider); !supported {
			continue
		}
		live := a.nativeRuntime.CredentialModels(row.ID)
		if len(live) == 0 || sameModelSet(live, row.Models) {
			continue
		}
		if _, err = a.store.UpsertUpstreamCredential(ctx, store.UpstreamCredentialInput{
			ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
			Models: live, Document: row.Document, Source: row.Source, ProxyID: row.ProxyID, ExpiresAt: row.ExpiresAt,
		}); err != nil {
			return fmt.Errorf("persist %s models for %s: %w", provider, row.ID, err)
		}
	}
	return nil
}

func sameModelSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, model := range left {
		counts[strings.ToLower(strings.TrimSpace(model))]++
	}
	for _, model := range right {
		key := strings.ToLower(strings.TrimSpace(model))
		if counts[key] == 0 {
			return false
		}
		counts[key]--
	}
	return true
}

func (a *App) migrateCredentialIdentity(ctx context.Context) error {
	if a == nil || a.store.DB == nil {
		return nil
	}
	if err := a.store.DB.WithContext(ctx).Exec(`
		UPDATE parent_subscriptions
		SET upstream_auth_index = upstream_credential_id
		WHERE COALESCE(upstream_auth_index, '') = ''
		  AND COALESCE(upstream_credential_id, '') <> ''
	`).Error; err != nil {
		return fmt.Errorf("backfill parent subscription auth index: %w", err)
	}
	return nil
}
