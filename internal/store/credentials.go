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

type UpstreamCredentialInput struct {
	ID        string
	Name      string
	Provider  string
	Enabled   bool
	Models    []string
	Document  json.RawMessage
	Source    string
	ExpiresAt *time.Time
}

type UpstreamCredentialSnapshot struct {
	ID        string
	Name      string
	Provider  string
	Enabled   bool
	Models    []string
	Document  json.RawMessage
	Source    string
	Revision  int64
	ExpiresAt *time.Time
}

func credentialAssociatedData(id string) string {
	return "relayapi/upstream-credential/v1/" + id
}

func (s Store) UpsertUpstreamCredential(ctx context.Context, input UpstreamCredentialInput) (UpstreamCredentialSnapshot, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	if input.ID == "" || input.Provider == "" || !json.Valid(input.Document) {
		return UpstreamCredentialSnapshot{}, fmt.Errorf("credential requires id, provider and valid JSON document")
	}
	sealed, err := s.secretBox.Seal(input.Document, credentialAssociatedData(input.ID))
	if err != nil {
		return UpstreamCredentialSnapshot{}, err
	}
	item := db.UpstreamCredential{
		ID: input.ID, Name: strings.TrimSpace(input.Name), Provider: input.Provider,
		Enabled: input.Enabled, Models: postgresStringArray(input.Models),
		SealedDocument: sealed, Source: strings.TrimSpace(input.Source), ExpiresAt: input.ExpiresAt,
	}
	if item.Name == "" {
		item.Name = item.ID
	}
	if item.Source == "" {
		item.Source = "native"
	}
	err = scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"name": item.Name, "provider": item.Provider, "enabled": item.Enabled,
			"models": item.Models, "sealed_document": item.SealedDocument, "source": item.Source,
			"expires_at": item.ExpiresAt, "revision": gormExpr("revision + 1"), "updated_at": time.Now(),
		}),
	}).Create(&item).Error
	if err != nil {
		return UpstreamCredentialSnapshot{}, err
	}
	return s.GetUpstreamCredential(ctx, input.ID)
}

func (s Store) GetUpstreamCredential(ctx context.Context, id string) (UpstreamCredentialSnapshot, error) {
	var item db.UpstreamCredential
	if err := scoped(ctx, s.DB).First(&item, "id = ?", strings.TrimSpace(id)).Error; err != nil {
		return UpstreamCredentialSnapshot{}, notFound(err)
	}
	return s.openUpstreamCredential(item)
}

func (s Store) ListUpstreamCredentials(ctx context.Context) ([]UpstreamCredentialSnapshot, error) {
	var items []db.UpstreamCredential
	if err := scoped(ctx, s.DB).Order("provider, name, id").Find(&items).Error; err != nil {
		return nil, err
	}
	result := make([]UpstreamCredentialSnapshot, 0, len(items))
	for _, item := range items {
		opened, err := s.openUpstreamCredential(item)
		if err != nil {
			return nil, fmt.Errorf("open credential %q: %w", item.ID, err)
		}
		result = append(result, opened)
	}
	return result, nil
}

func (s Store) openUpstreamCredential(item db.UpstreamCredential) (UpstreamCredentialSnapshot, error) {
	document, err := s.secretBox.Open(item.SealedDocument, credentialAssociatedData(item.ID))
	if err != nil {
		return UpstreamCredentialSnapshot{}, err
	}
	return UpstreamCredentialSnapshot{
		ID: item.ID, Name: item.Name, Provider: item.Provider, Enabled: item.Enabled,
		Models: append([]string(nil), item.Models...), Document: json.RawMessage(document),
		Source: item.Source, Revision: item.Revision, ExpiresAt: item.ExpiresAt,
	}, nil
}

// Kept local so callers cannot inject expressions into update maps.
func gormExpr(sql string) clause.Expr { return clause.Expr{SQL: sql} }
