package store

import (
	"context"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type RetentionPolicy struct {
	SummaryDays, SuccessDetailDays, ErrorDetailDays int
	LifecycleSuccessHours, LifecycleErrorDays       int
	ReservationDays, IncompleteReservationDays      int
	QuotaObservationDays, InvitationDays, BatchSize int
	MaxRuntime                                      time.Duration
}

type RetentionStats struct {
	Details, LifecycleEvents, LifecyclePayloads, Reservations, RequestLogs int64
	QuotaObservations, Invitations, Rollups                                int64
}

// RunRetention compacts request summaries into immutable daily facts before
// deleting them. Every mutation is bounded to a small transaction so routine
// retention cannot hold locks or generate an unbounded WAL burst.
func (s Store) RunRetention(ctx context.Context, now time.Time, policy RetentionPolicy) (RetentionStats, error) {
	stats := RetentionStats{}
	if policy.BatchSize < 1 {
		policy.BatchSize = 5_000
	}
	if policy.MaxRuntime <= 0 {
		policy.MaxRuntime = 30 * time.Second
	}
	deadline := time.Now().Add(policy.MaxRuntime)
	for time.Now().Before(deadline) {
		progress := int64(0)
		operations := []func() (int64, error){
			func() (int64, error) { return s.scrubLifecyclePayloads(ctx, policy.BatchSize) },
			func() (int64, error) {
				return s.deleteSuccessDetails(ctx, now.AddDate(0, 0, -policy.SuccessDetailDays), policy)
			},
			func() (int64, error) {
				if policy.ErrorDetailDays <= 0 {
					return 0, nil
				}
				return s.deleteOldDetails(ctx, now.AddDate(0, 0, -policy.ErrorDetailDays), policy.BatchSize)
			},
			func() (int64, error) { return s.deleteLifecycle(ctx, now, policy) },
			func() (int64, error) { return s.deleteReservations(ctx, now, policy) },
			func() (int64, error) {
				if policy.SummaryDays <= 0 {
					return 0, nil
				}
				return s.compactRequestLogs(ctx, now.AddDate(0, 0, -policy.SummaryDays), policy.BatchSize, &stats)
			},
			func() (int64, error) {
				if policy.QuotaObservationDays <= 0 {
					return 0, nil
				}
				return s.deleteQuotaObservations(ctx, now.AddDate(0, 0, -policy.QuotaObservationDays), policy.BatchSize)
			},
			func() (int64, error) {
				if policy.InvitationDays <= 0 {
					return 0, nil
				}
				return s.deleteInvitations(ctx, now.AddDate(0, 0, -policy.InvitationDays), policy.BatchSize)
			},
		}
		for index, operation := range operations {
			if time.Now().After(deadline) {
				break
			}
			count, err := operation()
			if err != nil {
				return stats, err
			}
			progress += count
			switch index {
			case 0:
				stats.LifecyclePayloads += count
			case 1, 2:
				stats.Details += count
			case 3:
				stats.LifecycleEvents += count
			case 4:
				stats.Reservations += count
			case 5:
				stats.RequestLogs += count
			case 6:
				stats.QuotaObservations += count
			case 7:
				stats.Invitations += count
			}
		}
		if progress == 0 {
			break
		}
	}
	return stats, nil
}

func (s Store) scrubLifecyclePayloads(ctx context.Context, batch int) (int64, error) {
	if batch > 100 {
		batch = 100
	}
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		result := tx.Exec(`WITH selected AS (
			SELECT id FROM upstream_lifecycle_events WHERE processed = true AND
				(headers <> '{}' OR response_headers <> '{}' OR body <> '' OR original_request <> '' OR request_body <> '' OR raw_json <> '')
			ORDER BY processed_at LIMIT ? FOR UPDATE SKIP LOCKED
		) UPDATE upstream_lifecycle_events AS event SET headers = '{}', response_headers = '{}', body = '',
			original_request = '', request_body = '', raw_json = '' FROM selected WHERE event.id = selected.id`, batch)
		return result.RowsAffected, result.Error
	})
}

func retentionTx(ctx context.Context, database *gorm.DB, work func(*gorm.DB) (int64, error)) (int64, error) {
	var count int64
	err := scoped(ctx, database).Transaction(func(tx *gorm.DB) error {
		var locked bool
		if err := tx.Raw("SELECT pg_try_advisory_xact_lock(?)", int64(0x52454c4159524554)).Scan(&locked).Error; err != nil {
			return err
		}
		if !locked {
			return nil
		}
		var err error
		count, err = work(tx)
		return err
	})
	return count, err
}

func (s Store) deleteSuccessDetails(ctx context.Context, cutoff time.Time, policy RetentionPolicy) (int64, error) {
	if policy.SuccessDetailDays <= 0 {
		return 0, nil
	}
	batch := policy.BatchSize
	if batch > 50 {
		batch = 50
	}
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		result := tx.Exec(`WITH selected AS (
			SELECT d.request_log_id FROM request_log_details d
			JOIN request_logs l ON l.id = d.request_log_id
			WHERE l.completed_at < ? AND l.status_code > 0 AND l.status_code < 400
				AND COALESCE(l.error_code, '') = ''
			ORDER BY l.completed_at LIMIT ? FOR UPDATE OF d SKIP LOCKED
		) DELETE FROM request_log_details AS detail USING selected
		WHERE detail.request_log_id = selected.request_log_id`, cutoff, batch)
		return result.RowsAffected, result.Error
	})
}

func (s Store) deleteOldDetails(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	if batch > 50 {
		batch = 50
	}
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		result := tx.Exec(`WITH selected AS (
			SELECT request_log_id FROM request_log_details WHERE created_at < ?
			ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED
		) DELETE FROM request_log_details AS detail USING selected
		WHERE detail.request_log_id = selected.request_log_id`, cutoff, batch)
		return result.RowsAffected, result.Error
	})
}

func (s Store) deleteLifecycle(ctx context.Context, now time.Time, policy RetentionPolicy) (int64, error) {
	if policy.LifecycleSuccessHours <= 0 || policy.LifecycleErrorDays <= 0 {
		return 0, nil
	}
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		var ids []string
		successCutoff := now.Add(-time.Duration(policy.LifecycleSuccessHours) * time.Hour)
		errorCutoff := now.AddDate(0, 0, -policy.LifecycleErrorDays)
		err := tx.Raw(`SELECT id FROM upstream_lifecycle_events WHERE
			((processed = false AND created_at < ?)
			 OR (processed = true AND (((outcome = '' OR outcome = 'succeeded') AND status_code < 400 AND created_at < ?)
			 OR (((outcome <> '' AND outcome <> 'succeeded') OR status_code >= 400) AND created_at < ?))))
			ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED`, successCutoff, successCutoff, errorCutoff, policy.BatchSize).Scan(&ids).Error
		if err != nil || len(ids) == 0 {
			return 0, err
		}
		result := tx.Where("id IN ?", ids).Delete(&db.UpstreamLifecycleEvent{})
		return result.RowsAffected, result.Error
	})
}

func (s Store) deleteReservations(ctx context.Context, now time.Time, policy RetentionPolicy) (int64, error) {
	if policy.ReservationDays <= 0 || policy.IncompleteReservationDays <= 0 {
		return 0, nil
	}
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		var ids []string
		normalCutoff := now.AddDate(0, 0, -policy.ReservationDays)
		incompleteCutoff := now.AddDate(0, 0, -policy.IncompleteReservationDays)
		err := tx.Raw(`SELECT request_id FROM request_reservations WHERE status <> 'active' AND
			((pricing_complete = true AND settled_at < ?) OR (pricing_complete = false AND settled_at < ?))
			ORDER BY settled_at LIMIT ? FOR UPDATE SKIP LOCKED`, normalCutoff, incompleteCutoff, policy.BatchSize).Scan(&ids).Error
		if err != nil || len(ids) == 0 {
			return 0, err
		}
		result := tx.Where("request_id IN ?", ids).Delete(&db.RequestReservation{})
		return result.RowsAffected, result.Error
	})
}

func (s Store) compactRequestLogs(ctx context.Context, cutoff time.Time, batch int, stats *RetentionStats) (int64, error) {
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		var ids []string
		if err := tx.Raw(`SELECT id FROM request_logs WHERE completed_at < ? ORDER BY completed_at
			LIMIT ? FOR UPDATE SKIP LOCKED`, cutoff, batch).Scan(&ids).Error; err != nil || len(ids) == 0 {
			return 0, err
		}
		var rollups []db.UsageDailyRollup
		if err := tx.Raw(liveUsageFactsSQL+` FROM request_logs WHERE id IN ? AND log_unit='step'
   GROUP BY 1,tenant_id,model,api_key_id`, ids).Scan(&rollups).Error; err != nil {
			return 0, err
		}
		columns := append(append([]string(nil), usageFactColumns...), "total_tokens")
		for index := range rollups {
			rollups[index].TotalTokens = rollups[index].PromptTokens + rollups[index].CompletionTokens
			rollups[index].UpdatedAt = time.Now()
			updates := map[string]any{"updated_at": time.Now(), "api_key_name": gorm.Expr("EXCLUDED.api_key_name"), "api_key_prefix": gorm.Expr("EXCLUDED.api_key_prefix")}
			for _, column := range columns {
				updates[column] = gorm.Expr("usage_rollups_v2." + column + " + EXCLUDED." + column)
			}
			if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "day"}, {Name: "tenant_id"}, {Name: "model"}, {Name: "api_key_id"}}, DoUpdates: clause.Assignments(updates)}).Create(&rollups[index]).Error; err != nil {
				return 0, err
			}
		}

		stats.Rollups += int64(len(rollups))
		if err := tx.Where("request_log_id IN ?", ids).Delete(&db.RequestLogDetail{}).Error; err != nil {
			return 0, err
		}
		if err := tx.Where("request_log_id IN ?", ids).Delete(&db.UpstreamLifecycleEvent{}).Error; err != nil {
			return 0, err
		}
		result := tx.Where("id IN ?", ids).Delete(&db.RequestLog{})
		return result.RowsAffected, result.Error
	})
}

func (s Store) deleteQuotaObservations(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		var ids []string
		if err := tx.Raw(`SELECT id FROM parent_quota_observations WHERE created_at < ? ORDER BY created_at
			LIMIT ? FOR UPDATE SKIP LOCKED`, cutoff, batch).Scan(&ids).Error; err != nil || len(ids) == 0 {
			return 0, err
		}
		result := tx.Where("id IN ?", ids).Delete(&db.ParentQuotaObservation{})
		return result.RowsAffected, result.Error
	})
}

func (s Store) deleteInvitations(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	return retentionTx(ctx, s.DB, func(tx *gorm.DB) (int64, error) {
		var ids []string
		if err := tx.Raw(`SELECT id FROM invitations WHERE created_at < ? AND
			(used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now()) ORDER BY created_at
			LIMIT ? FOR UPDATE SKIP LOCKED`, cutoff, batch).Scan(&ids).Error; err != nil || len(ids) == 0 {
			return 0, err
		}
		result := tx.Where("id IN ?", ids).Delete(&db.Invitation{})
		return result.RowsAffected, result.Error
	})
}
