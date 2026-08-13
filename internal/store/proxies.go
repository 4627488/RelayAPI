package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

type OutboundProxy struct {
	ID, Name, URL        string
	CreatedAt, UpdatedAt time.Time
}

func proxyAssociatedData(id string) string { return "relayapi/outbound-proxy/v1/" + id }

func (s Store) CreateOutboundProxy(ctx context.Context, name, rawURL string) (OutboundProxy, error) {
	id := identity.NewID()
	return s.saveOutboundProxy(ctx, id, name, rawURL, false)
}

func (s Store) UpdateOutboundProxy(ctx context.Context, id, name, rawURL string) (OutboundProxy, error) {
	return s.saveOutboundProxy(ctx, strings.TrimSpace(id), name, rawURL, true)
}

func (s Store) saveOutboundProxy(ctx context.Context, id, name, rawURL string, update bool) (OutboundProxy, error) {
	name, rawURL = strings.TrimSpace(name), strings.TrimSpace(rawURL)
	if id == "" || name == "" || rawURL == "" {
		return OutboundProxy{}, fmt.Errorf("proxy requires id, name and URL")
	}
	sealed, err := s.secretBox.Seal([]byte(rawURL), proxyAssociatedData(id))
	if err != nil {
		return OutboundProxy{}, err
	}
	if update {
		result := scoped(ctx, s.DB).Model(&db.OutboundProxy{}).Where("id = ?", id).Updates(map[string]any{
			"name": name, "sealed_url": sealed, "updated_at": time.Now().UTC(),
		})
		if result.Error != nil {
			return OutboundProxy{}, result.Error
		}
		if result.RowsAffected == 0 {
			return OutboundProxy{}, ErrNotFound
		}
	} else if err = scoped(ctx, s.DB).Create(&db.OutboundProxy{ID: id, Name: name, SealedURL: sealed}).Error; err != nil {
		return OutboundProxy{}, err
	}
	return s.GetOutboundProxy(ctx, id)
}

func (s Store) GetOutboundProxy(ctx context.Context, id string) (OutboundProxy, error) {
	var item db.OutboundProxy
	if err := scoped(ctx, s.DB).First(&item, "id = ?", strings.TrimSpace(id)).Error; err != nil {
		return OutboundProxy{}, notFound(err)
	}
	return s.openOutboundProxy(item)
}

func (s Store) ListOutboundProxies(ctx context.Context) ([]OutboundProxy, error) {
	var items []db.OutboundProxy
	if err := scoped(ctx, s.DB).Order("name, id").Find(&items).Error; err != nil {
		return nil, err
	}
	result := make([]OutboundProxy, 0, len(items))
	for _, item := range items {
		opened, err := s.openOutboundProxy(item)
		if err != nil {
			return nil, fmt.Errorf("open proxy %q: %w", item.ID, err)
		}
		result = append(result, opened)
	}
	return result, nil
}

func (s Store) openOutboundProxy(item db.OutboundProxy) (OutboundProxy, error) {
	rawURL, err := s.secretBox.Open(item.SealedURL, proxyAssociatedData(item.ID))
	if err != nil {
		return OutboundProxy{}, err
	}
	return OutboundProxy{ID: item.ID, Name: item.Name, URL: string(rawURL), CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}, nil
}

func (s Store) DeleteOutboundProxy(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	var references int64
	if err := scoped(ctx, s.DB).Model(&db.UpstreamCredential{}).Where("proxy_id = ?", id).Count(&references).Error; err != nil {
		return err
	}
	if references > 0 {
		return fmt.Errorf("proxy is used by %d model account(s)", references)
	}
	result := scoped(ctx, s.DB).Delete(&db.OutboundProxy{}, "id = ?", id)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s Store) CountOutboundProxyReferences(ctx context.Context, id string) (int64, error) {
	var references int64
	err := scoped(ctx, s.DB).Model(&db.UpstreamCredential{}).Where("proxy_id = ?", strings.TrimSpace(id)).Count(&references).Error
	return references, err
}
