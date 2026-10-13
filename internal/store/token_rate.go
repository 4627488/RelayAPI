package store

import (
	"context"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

type TokenRatePoint struct {
	Time            time.Time `json:"time"`
	Tokens          int64     `json:"tokens"`
	TokensPerSecond float64   `json:"tokens_per_second"`
}

// TodayTokenRate counts only output tokens from completed generation logs,
// once per log in one-minute buckets. Tokens in each point means output tokens.
// The current bucket uses elapsed seconds instead of a full minute.
func (s Store) TodayTokenRate(ctx context.Context, now time.Time, offsetMinutes int) ([]TokenRatePoint, error) {
	local := now.In(time.FixedZone("browser", offsetMinutes*60))
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	var rows []struct {
		Bucket int64
		Tokens int64
	}
	err := scoped(ctx, s.DB).Model(&db.RequestLog{}).Where(generationLogSQL).
		Where("completed_at >= ? AND completed_at <= ?", start, now).
		Select("floor(extract(epoch FROM completed_at) / 60)::bigint AS bucket, COALESCE(sum(completion_tokens), 0) AS tokens").
		Group("bucket").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	totals := make(map[int64]int64, len(rows))
	for _, row := range rows {
		totals[row.Bucket] = row.Tokens
	}
	return tokenRatePoints(start, now, totals), nil
}

func tokenRatePoints(start, now time.Time, totals map[int64]int64) []TokenRatePoint {
	points := make([]TokenRatePoint, 0, 1440)
	for at := start; !at.After(now); at = at.Add(time.Minute) {
		seconds := now.Sub(at).Seconds()
		if seconds > 60 {
			seconds = 60
		}
		if seconds < 1 {
			seconds = 1
		}
		tokens := totals[at.Unix()/60]
		points = append(points, TokenRatePoint{Time: at, Tokens: tokens, TokensPerSecond: float64(tokens) / seconds})
	}
	return points
}
