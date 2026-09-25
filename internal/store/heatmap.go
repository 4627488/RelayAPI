package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"regexp"
	"time"

	"github.com/4627488/RelayAPI/internal/heatmap"
)

var heatmapTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func ValidHeatmapToken(token string) bool { return heatmapTokenPattern.MatchString(token) }

// The sharing capability is independent of API keys and grants no API access.
func (s Store) RotateHeatmapShare(ctx context.Context, tenantID string) (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	result := scoped(ctx, s.DB).Model(&Tenant{}).Where("id = ? AND enabled = true", tenantID).
		Update("heatmap_share_token", token)
	if result.Error != nil {
		return "", result.Error
	}
	if result.RowsAffected == 0 {
		return "", ErrNotFound
	}
	return token, nil
}

func (s Store) RevokeHeatmapShare(ctx context.Context, tenantID string) error {
	return scoped(ctx, s.DB).Model(&Tenant{}).Where("id = ?", tenantID).
		Update("heatmap_share_token", nil).Error
}

func (s Store) HeatmapShare(ctx context.Context, tenantID string) (string, error) {
	var row struct{ HeatmapShareToken *string }
	err := scoped(ctx, s.DB).Model(&Tenant{}).Select("heatmap_share_token").Where("id = ?", tenantID).Take(&row).Error
	if err != nil {
		return "", notFound(err)
	}
	if row.HeatmapShareToken == nil {
		return "", nil
	}
	return *row.HeatmapShareToken, nil
}

func (s Store) ResolveHeatmapShare(ctx context.Context, token string) (string, error) {
	if !ValidHeatmapToken(token) {
		return "", ErrNotFound
	}
	var row struct{ ID string }
	err := scoped(ctx, s.DB).Model(&Tenant{}).Select("id").
		Where("heatmap_share_token = ? AND enabled = true", token).Take(&row).Error
	return row.ID, notFound(err)
}

func (s Store) TokenHeatmap(ctx context.Context, tenantID string, now time.Time) (heatmap.Report, error) {
	start, end := heatmap.Window(now)
	var rows []heatmap.Usage
	// A single statement sees a consistent snapshot while retention atomically
	// moves logs into rollups. Two separate reads could count a request twice.
	err := scoped(ctx, s.DB).Raw(`SELECT day, model, SUM(tokens) AS tokens FROM (
		SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
			model, SUM(GREATEST(total_tokens, 0)) AS tokens
		FROM request_logs WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
		GROUP BY 1, model
		UNION ALL
		SELECT to_char(day, 'YYYY-MM-DD') AS day, model, SUM(GREATEST(total_tokens, 0)) AS tokens
		FROM usage_daily_rollups WHERE tenant_id = ? AND day >= ?::date AND day < ?::date
		GROUP BY 1, model
	) usage GROUP BY day, model ORDER BY day, model`,
		tenantID, start, end, tenantID, start.Format(time.DateOnly), end.Format(time.DateOnly)).Scan(&rows).Error
	if err != nil {
		return heatmap.Report{}, err
	}
	return heatmap.Build(now, rows), nil
}
