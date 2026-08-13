package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/lib/pq"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrSubscriptionRequired  = errors.New("no eligible child subscription")
	ErrSubscriptionExhausted = errors.New("child subscription quota exhausted")
	ErrSubscriptionPrice     = errors.New("priced model is required for metered subscription")
)

// Upstream rolling-window reset timestamps are often derived from a rounded
// countdown and can move by a few seconds between probes. Treat nearby values
// as the same generation; a real reset advances by hours or days.
const quotaResetJitterTolerance = time.Minute

// Small percentage movements are dominated by provider-side rounding and by
// requests crossing the observation boundary. Accumulate changes from the
// last calibration anchor until the upstream meter has moved by at least 0.1%.
const (
	quotaCalibrationMinDeltaMicros = int64(100_000)
	quotaEstimateSampleLimit       = 21
)

type ParentSubscription = db.ParentSubscription
type ParentQuotaWindow = db.ParentQuotaWindow
type ParentQuotaObservation = db.ParentQuotaObservation
type ChildSubscription = db.ChildSubscription
type ChildQuotaWindow = db.ChildQuotaWindow
type RequestReservation = db.RequestReservation
type WebSocketTurn = db.WebSocketTurn

type SubscriptionCandidate struct {
	Child  ChildSubscription
	Parent ParentSubscription
}

type AdmissionInput struct {
	RequestID       string
	Key             KeyContext
	Model           string
	BalanceReserve  int64
	QuotaReserve    int64
	PriceConfigured bool
	PriceSnapshot   json.RawMessage
	ExpiresAt       time.Time
}

type Admission struct {
	RequestID              string
	ParentSubscriptionID   string
	ChildSubscriptionID    string
	CPAAuthID              string
	CPAAuthIndex           string
	BalanceReservedNanoUSD int64
	QuotaReservedNanoUSD   int64
}

type WebSocketTurnAccrual struct {
	RequestID       string
	TurnID          string
	Usage           Usage
	CostNanoUSD     int64
	PricingComplete bool
	Log             LogInput
}

type quotaWindowReservation struct {
	Kind     string    `json:"kind"`
	ResetsAt time.Time `json:"resets_at"`
}

func (s Store) ListParentSubscriptions(ctx context.Context) ([]ParentSubscription, error) {
	var items []ParentSubscription
	err := scoped(ctx, s.DB).Where("status <> ?", "missing").Order("created_at DESC").Find(&items).Error
	return items, err
}

func (s Store) GetParentSubscription(ctx context.Context, id string) (ParentSubscription, error) {
	var item ParentSubscription
	err := scoped(ctx, s.DB).Where("status <> ?", "missing").First(&item, "id = ?", id).Error
	return item, notFound(err)
}

func (s Store) GetParentSubscriptionByCPAAuthIndex(ctx context.Context, authIndex string) (ParentSubscription, error) {
	var item ParentSubscription
	err := scoped(ctx, s.DB).Where("status <> ?", "missing").First(&item, "cpa_auth_index = ?", strings.TrimSpace(authIndex)).Error
	return item, notFound(err)
}

func (s Store) UpsertParentSubscription(ctx context.Context, item ParentSubscription) (ParentSubscription, error) {
	if item.ID == "" {
		item.ID = identity.NewID()
	}
	item.CPAAuthID = strings.TrimSpace(item.CPAAuthID)
	item.CPAAuthIndex = strings.TrimSpace(item.CPAAuthIndex)
	if item.CPAAuthIndex == "" {
		item.CPAAuthIndex = item.CPAAuthID
	}
	item.CPAAuthName = strings.TrimSpace(item.CPAAuthName)
	item.Name = strings.TrimSpace(item.Name)
	item.Provider = strings.TrimSpace(item.Provider)
	if item.Name == "" {
		item.Name = firstNonEmpty(item.CPAAuthName, item.CPAAuthID)
	}
	if item.CapacityMode == "" {
		item.CapacityMode = db.ParentCapacityUnmetered
	}
	// Kept at 100% for schema compatibility and as the oversubscription
	// warning baseline. It is not an enforcement limit.
	item.AllocationLimitPPM = 1_000_000
	if len(item.Metadata) == 0 {
		item.Metadata = json.RawMessage(`{}`)
	}
	if len(item.QuotaSnapshot) == 0 {
		item.QuotaSnapshot = json.RawMessage(`{}`)
	}
	err := scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "cpa_auth_index"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"cpa_auth_id", "cpa_auth_name", "name", "provider", "plan_type", "status", "cpa_unavailable", "capacity_mode",
			"allocation_limit_ppm", "enabled", "model_allowlist", "metadata", "last_synced_at", "updated_at",
		}),
	}).Create(&item).Error
	if err != nil {
		return ParentSubscription{}, err
	}
	var result ParentSubscription
	err = scoped(ctx, s.DB).First(&result, "cpa_auth_index = ?", item.CPAAuthIndex).Error
	return result, err
}

func (s Store) SyncParentSubscription(ctx context.Context, item ParentSubscription) (ParentSubscription, error) {
	if item.ID == "" {
		item.ID = identity.NewID()
	}
	item.CPAAuthID = strings.TrimSpace(item.CPAAuthID)
	item.CPAAuthIndex = strings.TrimSpace(item.CPAAuthIndex)
	if item.CPAAuthIndex == "" {
		item.CPAAuthIndex = item.CPAAuthID
	}
	item.CPAAuthName = strings.TrimSpace(item.CPAAuthName)
	item.Name = strings.TrimSpace(item.Name)
	if item.Name == "" {
		item.Name = firstNonEmpty(item.CPAAuthName, item.CPAAuthID)
	}
	if len(item.Metadata) == 0 {
		item.Metadata = json.RawMessage(`{}`)
	}
	if len(item.QuotaSnapshot) == 0 {
		item.QuotaSnapshot = json.RawMessage(`{}`)
	}
	if item.CapacityMode == "" {
		item.CapacityMode = db.ParentCapacityUnmetered
	}
	if item.AllocationLimitPPM == 0 {
		item.AllocationLimitPPM = 1_000_000
	}
	err := scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "cpa_auth_index"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"cpa_auth_id", "cpa_auth_name", "provider", "plan_type", "status", "cpa_unavailable", "cpa_model_allowlist", "metadata", "last_synced_at", "updated_at",
		}),
	}).Create(&item).Error
	if err != nil {
		return ParentSubscription{}, err
	}
	var result ParentSubscription
	err = scoped(ctx, s.DB).First(&result, "cpa_auth_index = ?", item.CPAAuthIndex).Error
	return result, err
}

// SyncNativeParentSubscription uses the credential ID as the durable identity.
// Native credentials do not have the separate scheduler auth index used by the
// legacy external CPA control plane.
func (s Store) SyncNativeParentSubscription(ctx context.Context, item ParentSubscription) (ParentSubscription, error) {
	if item.ID == "" {
		item.ID = identity.NewID()
	}
	item.CPAAuthID = strings.TrimSpace(item.CPAAuthID)
	if item.CPAAuthID == "" {
		return ParentSubscription{}, fmt.Errorf("native parent credential id is required")
	}
	item.CPAAuthIndex = item.CPAAuthID
	item.CPAAuthName = firstNonEmpty(strings.TrimSpace(item.CPAAuthName), item.CPAAuthID)
	item.Name = firstNonEmpty(strings.TrimSpace(item.Name), item.CPAAuthName)
	item.Provider = strings.TrimSpace(item.Provider)
	if len(item.Metadata) == 0 {
		item.Metadata = json.RawMessage(`{}`)
	}
	if len(item.QuotaSnapshot) == 0 {
		item.QuotaSnapshot = json.RawMessage(`{}`)
	}
	err := scoped(ctx, s.DB).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "cpa_auth_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"cpa_auth_index", "cpa_auth_name", "provider", "status", "cpa_unavailable", "cpa_model_allowlist", "metadata", "last_synced_at", "updated_at",
		}),
	}).Create(&item).Error
	if err != nil {
		return ParentSubscription{}, err
	}
	var result ParentSubscription
	err = scoped(ctx, s.DB).First(&result, "cpa_auth_id = ?", item.CPAAuthID).Error
	return result, err
}

func (s Store) MarkMissingParentSubscriptions(ctx context.Context, seen []string, syncStartedAt time.Time) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		query := tx.Model(&ParentSubscription{}).
			Where("last_synced_at IS NOT NULL AND last_synced_at < ?", syncStartedAt)
		if len(seen) > 0 {
			query = query.Where("cpa_auth_index NOT IN ?", seen)
		}
		var missingIDs []string
		if err := query.Pluck("id", &missingIDs).Error; err != nil || len(missingIDs) == 0 {
			return err
		}
		now := time.Now()
		if err := tx.Model(&ParentSubscription{}).Where("id IN ?", missingIDs).Updates(map[string]any{
			"cpa_unavailable": true,
			"enabled":         false,
			"status":          "missing",
			"updated_at":      now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Model(&ChildSubscription{}).Where("parent_subscription_id IN ?", missingIDs).
			Updates(map[string]any{"enabled": false, "updated_at": now}).Error; err != nil {
			return err
		}

		// A deleted credential is authoritative: release any in-flight holds at
		// zero cost, then remove all current subscription state. Late terminal
		// events are idempotent because released reservations cannot settle again.
		for _, parentID := range missingIDs {
			childIDs := tx.Model(&ChildSubscription{}).Select("id").Where("parent_subscription_id = ?", parentID)
			var active []RequestReservation
			if err := tx.Model(&RequestReservation{}).
				Where("status = ? AND (parent_subscription_id = ? OR child_subscription_id IN (?))", db.ReservationActive, parentID, childIDs).
				Find(&active).Error; err != nil {
				return err
			}
			for _, reservation := range active {
				if err := finishReservationTx(tx, reservation.RequestID, 0, false, db.ReservationReleased); err != nil {
					return err
				}
			}
			if err := tx.Where("parent_subscription_id = ?", parentID).Delete(&ChildSubscription{}).Error; err != nil {
				return err
			}
			if err := tx.Where("id = ?", parentID).Delete(&ParentSubscription{}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (s Store) UpdateParentQuotaProbe(ctx context.Context, parentID string, supported bool, status, message, planType string, observedAt *time.Time, snapshot json.RawMessage) error {
	updates := map[string]any{
		"quota_supported":    supported,
		"quota_probe_status": strings.TrimSpace(status),
		"quota_probe_error":  strings.TrimSpace(message),
		"updated_at":         time.Now(),
	}
	if observedAt != nil && !observedAt.IsZero() {
		updates["quota_observed_at"] = observedAt
	}
	if strings.TrimSpace(planType) != "" {
		updates["plan_type"] = strings.TrimSpace(planType)
	}
	if len(snapshot) > 0 && json.Valid(snapshot) {
		updates["quota_snapshot"] = snapshot
	}
	result := scoped(ctx, s.DB).Model(&ParentSubscription{}).Where("id = ?", parentID).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s Store) UpdateParentSubscription(ctx context.Context, item ParentSubscription) (ParentSubscription, error) {
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var current ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", item.ID).Error; err != nil {
			return notFound(err)
		}
		if err := tx.Model(&current).Updates(map[string]any{
			"name": strings.TrimSpace(item.Name), "plan_type": strings.TrimSpace(item.PlanType),
			"capacity_mode": item.CapacityMode, "allocation_limit_ppm": 1_000_000,
			"enabled": item.Enabled, "model_allowlist": item.ModelAllowlist, "updated_at": time.Now(),
		}).Error; err != nil {
			return err
		}
		if item.CapacityMode == db.ParentCapacityUnmetered {
			return tx.Model(&ChildSubscription{}).Where("parent_subscription_id = ?", item.ID).Updates(map[string]any{
				"name": strings.TrimSpace(item.Name), "allocation_ppm": 1_000_000, "priority": 100,
				"model_allowlist": pq.StringArray{}, "starts_at": time.Now(), "expires_at": nil, "updated_at": time.Now(),
			}).Error
		}
		return nil
	})
	if err != nil {
		return ParentSubscription{}, err
	}
	return s.GetParentSubscription(ctx, item.ID)
}

func (s Store) SetParentQuotaWindows(ctx context.Context, parentID string, windows []ParentQuotaWindow) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var parent ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, "id = ?", parentID).Error; err != nil {
			return notFound(err)
		}
		var existingManualWindows []ParentQuotaWindow
		if err := tx.Where("parent_subscription_id = ? AND source = ?", parentID, db.ParentQuotaSourceManualConversion).
			Find(&existingManualWindows).Error; err != nil {
			return err
		}
		kinds := make([]string, 0, len(windows))
		kindSet := make(map[string]struct{}, len(windows))
		for _, window := range windows {
			window.ParentSubscriptionID = parentID
			window.Kind = strings.TrimSpace(window.Kind)
			if window.Kind == "" || window.LimitNanoUSD <= 0 || !window.ResetsAt.After(time.Now()) {
				return errors.New("invalid parent quota window")
			}
			if window.Source == "" {
				window.Source = db.ParentQuotaSourceManualConversion
			}
			var existing ParentQuotaWindow
			existingErr := tx.First(&existing, "parent_subscription_id = ? AND kind = ?", parentID, window.Kind).Error
			if existingErr == nil {
				delta := window.ResetsAt.Sub(existing.ResetsAt)
				if delta >= -quotaResetJitterTolerance && delta <= quotaResetJitterTolerance {
					window.ResetsAt = existing.ResetsAt
				} else if delta < 0 {
					return errors.New("quota window resets_at cannot move backwards")
				}
			}
			if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
				return existingErr
			}
			kinds = append(kinds, window.Kind)
			kindSet[window.Kind] = struct{}{}
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "parent_subscription_id"}, {Name: "kind"}},
				DoUpdates: clause.AssignmentColumns([]string{"limit_nano_usd", "resets_at", "source", "observed_used_percent", "observed_at", "updated_at"}),
			}).Create(&window).Error; err != nil {
				return err
			}
			if err := syncChildQuotaWindowGeneration(tx, parentID, window.Kind, window.LimitNanoUSD, window.ResetsAt, time.Now()); err != nil {
				return err
			}
		}
		// This endpoint owns administrator overrides only. Automatically learned
		// windows keep evolving unless an administrator explicitly replaces the
		// same kind; saving one override must not erase unrelated estimates.
		deleteQuery := tx.Where("parent_subscription_id = ? AND source = ?", parentID, db.ParentQuotaSourceManualConversion)
		if len(kinds) > 0 {
			deleteQuery = deleteQuery.Where("kind NOT IN ?", kinds)
		}
		if err := deleteQuery.Delete(&ParentQuotaWindow{}).Error; err != nil {
			return err
		}
		// Clearing a manual override should immediately reveal the best estimate
		// already learned for its current generation instead of waiting for the
		// next scheduled upstream probe.
		for _, existing := range existingManualWindows {
			if _, configured := kindSet[existing.Kind]; configured {
				continue
			}
			limit, observed, ok, err := learnedQuotaWindow(tx, parentID, existing.Kind)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			window := ParentQuotaWindow{
				ParentSubscriptionID: parentID, Kind: existing.Kind, LimitNanoUSD: limit,
				ResetsAt: observed.ResetsAt, Source: db.ParentCapacityObserved,
				ObservedUsedPercent: &observed.UsedPercent, ObservedAt: &observed.ObservedAt,
			}
			if err := tx.Create(&window).Error; err != nil {
				return err
			}
			if err := syncChildQuotaWindowGeneration(tx, parentID, window.Kind, limit, window.ResetsAt, observed.ObservedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s Store) ListParentQuotaWindows(ctx context.Context, parentID string) ([]ParentQuotaWindow, error) {
	var items []ParentQuotaWindow
	err := scoped(ctx, s.DB).Where("parent_subscription_id = ?", parentID).Order("kind").Find(&items).Error
	return items, err
}

func (s Store) RecordParentQuotaObservation(ctx context.Context, parentID, kind string, usedPercent float64, resetsAt, observedAt time.Time) (ParentQuotaObservation, error) {
	observation := ParentQuotaObservation{
		ID: identity.NewID(), ParentSubscriptionID: parentID, Kind: strings.TrimSpace(kind),
		UsedPercent: usedPercent, ResetsAt: resetsAt, ObservedAt: observedAt,
	}
	if observation.Kind == "" || usedPercent < 0 || usedPercent > 100 || resetsAt.IsZero() || observedAt.IsZero() ||
		!resetsAt.After(observedAt) || observedAt.After(time.Now().Add(5*time.Minute)) {
		return observation, errors.New("invalid parent quota observation")
	}
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var parent ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, "id = ?", parentID).Error; err != nil {
			return notFound(err)
		}
		var currentWindow ParentQuotaWindow
		currentWindowErr := tx.First(&currentWindow, "parent_subscription_id = ? AND kind = ?", parentID, observation.Kind).Error
		if currentWindowErr == nil {
			delta := resetsAt.Sub(currentWindow.ResetsAt)
			if delta >= -quotaResetJitterTolerance && delta <= quotaResetJitterTolerance {
				resetsAt = currentWindow.ResetsAt
				observation.ResetsAt = resetsAt
			} else if delta < 0 {
				return errors.New("quota observation resets_at cannot move backwards")
			}
		} else if !errors.Is(currentWindowErr, gorm.ErrRecordNotFound) {
			return currentWindowErr
		}
		var previous ParentQuotaObservation
		previousErr := tx.Where("parent_subscription_id = ? AND kind = ?", parentID, observation.Kind).
			Order("observed_at DESC").First(&previous).Error
		if previousErr == nil && currentWindowErr != nil && errors.Is(currentWindowErr, gorm.ErrRecordNotFound) {
			// A window does not exist until the first estimate is accepted. Normalize
			// reset jitter against the observation history as well, otherwise a
			// rounded upstream countdown can keep learning mode stuck forever.
			delta := resetsAt.Sub(previous.ResetsAt)
			if delta >= -quotaResetJitterTolerance && delta <= quotaResetJitterTolerance {
				resetsAt = previous.ResetsAt
				observation.ResetsAt = resetsAt
			}
		}
		observation.Reason = "initial_sample"
		unchanged := false
		if previousErr == nil {
			if !observedAt.After(previous.ObservedAt) {
				return errors.New("observation must be newer than the previous sample")
			}
			// Integer-only providers such as Codex often return the same value for
			// many consecutive probes. Keeping every duplicate adds no calibration
			// information; retain the preceding change point as the cost baseline.
			if previous.ResetsAt.Equal(resetsAt) && math.Abs(usedPercent-previous.UsedPercent) < 1e-9 {
				observation = previous
				observation.Reason = "unchanged"
				unchanged = true
			}
			if unchanged {
				// Keep the change-point sample for capacity estimation, but still
				// refresh the parent and child window timestamps below.
			} else if !previous.ResetsAt.Equal(resetsAt) {
				observation.Reason = "window_reset"
			} else if usedPercent < previous.UsedPercent {
				observation.Reason = "percentage_decreased"
			} else {
				baseline, baselineErr := quotaCalibrationBaseline(tx, parentID, observation.Kind, resetsAt, previous)
				if baselineErr != nil {
					return baselineErr
				}
				deltaMicros := int64(math.Round((usedPercent - baseline.UsedPercent) * 1_000_000))
				if deltaMicros < quotaCalibrationMinDeltaMicros {
					observation.Reason = "percentage_delta_too_small"
				} else {
					type totals struct {
						Cost       int64
						Incomplete int64
					}
					var total totals
					if err := tx.Model(&db.RequestLog{}).Select(
						"COALESCE(sum(CASE WHEN pricing_complete = true THEN cost_nano_usd ELSE 0 END),0) AS cost, "+
							"COALESCE(sum(CASE WHEN pricing_complete = false AND status_code >= 200 AND status_code < 300 AND model <> '' THEN 1 ELSE 0 END),0) AS incomplete",
					).Where("auth_index = ? AND settled = ? AND completed_at > ? AND completed_at <= ?", parent.CPAAuthIndex, true, baseline.ObservedAt, observedAt).
						Scan(&total).Error; err != nil {
						return err
					}
					observation.CostSincePrevious = total.Cost
					switch {
					case total.Incomplete > 0:
						observation.Reason = "incomplete_pricing"
					case total.Cost <= 0:
						observation.Reason = "missing_usage"
					default:
						estimated := percentageCapacity(total.Cost, deltaMicros)
						observation.EstimatedLimit = &estimated
						observation.Accepted = true
						observation.Reason = "accepted"
					}
				}
			}
		} else if !errors.Is(previousErr, gorm.ErrRecordNotFound) {
			return previousErr
		}

		if !unchanged {
			if err := tx.Create(&observation).Error; err != nil {
				return err
			}
		}
		existing, windowErr := currentWindow, currentWindowErr
		limit := int64(0)
		source := db.ParentCapacityObserved
		if windowErr == nil && existing.Source == db.ParentQuotaSourceManualConversion {
			// The upstream owns observed window timing, while the administrator
			// may explicitly own the conversion from that window to USD.
			limit = existing.LimitNanoUSD
			source = db.ParentQuotaSourceManualConversion
		} else if observation.EstimatedLimit != nil {
			var estimateErr error
			limit, estimateErr = quotaGenerationEstimate(tx, parentID, observation.Kind, resetsAt)
			if estimateErr != nil {
				return estimateErr
			}
		} else if windowErr == nil {
			limit = existing.LimitNanoUSD
		}
		if limit > 0 {
			window := ParentQuotaWindow{
				ParentSubscriptionID: parentID, Kind: observation.Kind, LimitNanoUSD: limit,
				ResetsAt: resetsAt, Source: source, ObservedUsedPercent: &usedPercent, ObservedAt: &observedAt,
			}
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "parent_subscription_id"}, {Name: "kind"}},
				DoUpdates: clause.AssignmentColumns([]string{"limit_nano_usd", "resets_at", "source", "observed_used_percent", "observed_at", "updated_at"}),
			}).Create(&window).Error; err != nil {
				return err
			}
			if err := syncChildQuotaWindowGeneration(tx, parentID, observation.Kind, limit, resetsAt, observedAt); err != nil {
				return err
			}
		}
		return nil
	})
	return observation, err
}

func quotaCalibrationBaseline(tx *gorm.DB, parentID, kind string, resetsAt time.Time, fallback ParentQuotaObservation) (ParentQuotaObservation, error) {
	var baseline ParentQuotaObservation
	err := tx.Where(
		"parent_subscription_id = ? AND kind = ? AND resets_at = ? AND (accepted = ? OR reason IN ?)",
		parentID, kind, resetsAt, true, []string{"initial_sample", "window_reset", "percentage_decreased"},
	).Order("observed_at DESC").First(&baseline).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return fallback, nil
	}
	return baseline, err
}

func quotaGenerationEstimate(tx *gorm.DB, parentID, kind string, resetsAt time.Time) (int64, error) {
	var estimates []int64
	err := tx.Model(&ParentQuotaObservation{}).
		Where("parent_subscription_id = ? AND kind = ? AND resets_at = ? AND accepted = ? AND estimated_limit IS NOT NULL",
			parentID, kind, resetsAt, true).
		Order("observed_at DESC").Limit(quotaEstimateSampleLimit).Pluck("estimated_limit", &estimates).Error
	if err != nil {
		return 0, err
	}
	return medianInt64(estimates), nil
}

func learnedQuotaWindow(tx *gorm.DB, parentID, kind string) (int64, ParentQuotaObservation, bool, error) {
	var latest ParentQuotaObservation
	err := tx.Where("parent_subscription_id = ? AND kind = ?", parentID, kind).
		Order("observed_at DESC").First(&latest).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, ParentQuotaObservation{}, false, nil
	}
	if err != nil {
		return 0, ParentQuotaObservation{}, false, err
	}
	if !latest.ResetsAt.After(time.Now()) {
		return 0, latest, false, nil
	}
	limit, err := quotaGenerationEstimate(tx, parentID, kind, latest.ResetsAt)
	return limit, latest, limit > 0, err
}

// syncChildQuotaWindowGeneration makes the persisted child state follow the
// authoritative parent generation. A generation change atomically clears old
// usage; an update within the same generation only adjusts the allocated limit.
// Reservations carry their generation's resets_at, so late settlements from an
// old generation cannot debit the newly reset window.
func syncChildQuotaWindowGeneration(tx *gorm.DB, parentID, kind string, parentLimit int64, resetsAt, startedAt time.Time) error {
	var children []ChildSubscription
	if err := tx.Where("parent_subscription_id = ?", parentID).Find(&children).Error; err != nil {
		return err
	}
	for _, child := range children {
		limit := fraction(parentLimit, child.AllocationPPM)
		var current ChildQuotaWindow
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current,
			"child_subscription_id = ? AND kind = ?", child.ID, kind).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			window := ChildQuotaWindow{ChildSubscriptionID: child.ID, Kind: kind, StartedAt: startedAt,
				ResetsAt: resetsAt, LimitNanoUSD: limit}
			if err := tx.Create(&window).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		case current.ResetsAt.Equal(resetsAt):
			if err := tx.Model(&current).Updates(map[string]any{"limit_nano_usd": limit, "updated_at": time.Now()}).Error; err != nil {
				return err
			}
		case resetsAt.After(current.ResetsAt):
			if err := tx.Model(&current).Updates(map[string]any{
				"started_at": startedAt, "resets_at": resetsAt, "limit_nano_usd": limit,
				"settled_nano_usd": 0, "reserved_nano_usd": 0, "updated_at": time.Now(),
			}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func (s Store) ListParentQuotaObservations(ctx context.Context, parentID string, limit int) ([]ParentQuotaObservation, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	var items []ParentQuotaObservation
	err := scoped(ctx, s.DB).Where("parent_subscription_id = ?", parentID).
		Order("observed_at DESC").Limit(limit).Find(&items).Error
	return items, err
}

func (s Store) ListChildSubscriptions(ctx context.Context, tenantID string) ([]ChildSubscription, error) {
	var items []ChildSubscription
	query := scoped(ctx, s.DB).
		Select("child_subscriptions.*").
		Joins("JOIN parent_subscriptions ON parent_subscriptions.id = child_subscriptions.parent_subscription_id").
		Where("parent_subscriptions.status <> ?", "missing").
		Order("child_subscriptions.priority DESC, child_subscriptions.created_at DESC")
	if tenantID != "" {
		query = query.Where("child_subscriptions.tenant_id = ?", tenantID)
	}
	err := query.Find(&items).Error
	return items, err
}

func (s Store) CreateChildSubscription(ctx context.Context, item ChildSubscription) (ChildSubscription, error) {
	if item.ID == "" {
		item.ID = identity.NewID()
	}
	item.Name = strings.TrimSpace(item.Name)
	item.TenantID = strings.TrimSpace(item.TenantID)
	item.ParentSubscriptionID = strings.TrimSpace(item.ParentSubscriptionID)
	if item.Name == "" || item.TenantID == "" || item.ParentSubscriptionID == "" || item.AllocationPPM <= 0 {
		return ChildSubscription{}, errors.New("name, tenant, parent and positive allocation_ppm are required")
	}
	if item.StartsAt.IsZero() {
		item.StartsAt = time.Now()
	}
	if item.ExpiresAt != nil && !item.ExpiresAt.After(item.StartsAt) {
		return ChildSubscription{}, errors.New("expires_at must be after starts_at")
	}
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var parent ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, "id = ?", item.ParentSubscriptionID).Error; err != nil {
			return notFound(err)
		}
		if parent.Status == "missing" {
			return ErrNotFound
		}
		if parent.CapacityMode == db.ParentCapacityUnmetered {
			item = canonicalBalanceGrant(parent, item)
		}
		if item.Enabled && (!parent.Enabled || parent.CPAUnavailable) {
			return errors.New("enabled child subscription requires an available parent")
		}
		var tenant Tenant
		if err := tx.First(&tenant, "id = ?", item.TenantID).Error; err != nil {
			return notFound(err)
		}
		return tx.Create(&item).Error
	})
	return item, err
}

func (s Store) UpdateChildSubscription(ctx context.Context, item ChildSubscription) (ChildSubscription, error) {
	item.Name = strings.TrimSpace(item.Name)
	item.ParentSubscriptionID = strings.TrimSpace(item.ParentSubscriptionID)
	if item.Name == "" || item.ParentSubscriptionID == "" || item.AllocationPPM <= 0 || item.StartsAt.IsZero() {
		return ChildSubscription{}, errors.New("name, parent, starts_at and positive allocation_ppm are required")
	}
	if item.ExpiresAt != nil && !item.ExpiresAt.After(item.StartsAt) {
		return ChildSubscription{}, errors.New("expires_at must be after starts_at")
	}
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var current ChildSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", item.ID).Error; err != nil {
			return notFound(err)
		}
		var parent ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, "id = ?", item.ParentSubscriptionID).Error; err != nil {
			return notFound(err)
		}
		if parent.Status == "missing" {
			return ErrNotFound
		}
		if parent.CapacityMode == db.ParentCapacityUnmetered {
			item = canonicalBalanceGrant(parent, item)
			item.StartsAt = current.StartsAt
		}
		if item.Enabled && (!parent.Enabled || parent.CPAUnavailable) {
			return errors.New("enabled child subscription requires an available parent")
		}
		return tx.Model(&current).Updates(map[string]any{
			"parent_subscription_id": item.ParentSubscriptionID,
			"name":                   item.Name, "allocation_ppm": item.AllocationPPM, "priority": item.Priority,
			"enabled": item.Enabled, "model_allowlist": item.ModelAllowlist, "starts_at": item.StartsAt,
			"expires_at": item.ExpiresAt, "updated_at": time.Now(),
		}).Error
	})
	if err != nil {
		return ChildSubscription{}, err
	}
	var result ChildSubscription
	err = scoped(ctx, s.DB).First(&result, "id = ?", item.ID).Error
	return result, err
}

func (s Store) DeleteChildSubscription(ctx context.Context, id string) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var active int64
		if err := tx.Model(&RequestReservation{}).
			Where("child_subscription_id = ? AND status = ?", id, db.ReservationActive).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return errors.New("child subscription has active reservations")
		}
		result := tx.Where("id = ?", id).Delete(&ChildSubscription{})
		if result.Error == nil && result.RowsAffected == 0 {
			return ErrNotFound
		}
		return result.Error
	})
}

// GrantBalanceSubscriptionAccess gives each tenant access to every model
// exposed by an unmetered parent. These rows are access grants rather than
// quota slices: they intentionally carry no child model restriction, expiry,
// or individually configurable allocation.
func (s Store) GrantBalanceSubscriptionAccess(ctx context.Context, parentID string, tenantIDs []string) ([]ChildSubscription, error) {
	parentID = strings.TrimSpace(parentID)
	normalizedTenantIDs := make([]string, 0, len(tenantIDs))
	seen := make(map[string]struct{}, len(tenantIDs))
	for _, tenantID := range tenantIDs {
		tenantID = strings.TrimSpace(tenantID)
		if tenantID == "" {
			continue
		}
		if _, exists := seen[tenantID]; exists {
			continue
		}
		seen[tenantID] = struct{}{}
		normalizedTenantIDs = append(normalizedTenantIDs, tenantID)
	}
	if parentID == "" || len(normalizedTenantIDs) == 0 {
		return nil, errors.New("parent and at least one tenant are required")
	}

	items := make([]ChildSubscription, 0, len(normalizedTenantIDs))
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var parent ParentSubscription
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, "id = ?", parentID).Error; err != nil {
			return notFound(err)
		}
		if parent.Status == "missing" {
			return ErrNotFound
		}
		if parent.CapacityMode != db.ParentCapacityUnmetered {
			return errors.New("bulk access grants require a balance-settled parent")
		}
		if !parent.Enabled || parent.CPAUnavailable {
			return errors.New("balance-settled parent is unavailable")
		}

		var tenants []Tenant
		if err := tx.Where("id IN ? AND enabled = ?", normalizedTenantIDs, true).Find(&tenants).Error; err != nil {
			return err
		}
		enabled := make(map[string]struct{}, len(tenants))
		for _, tenant := range tenants {
			enabled[tenant.ID] = struct{}{}
		}
		for _, tenantID := range normalizedTenantIDs {
			if _, ok := enabled[tenantID]; !ok {
				return fmt.Errorf("tenant %s is missing or disabled", tenantID)
			}
		}

		now := time.Now()
		for _, tenantID := range normalizedTenantIDs {
			var item ChildSubscription
			err := tx.Where("tenant_id = ? AND parent_subscription_id = ?", tenantID, parent.ID).
				Order("created_at").First(&item).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				item = canonicalBalanceGrant(parent, ChildSubscription{
					ID: identity.NewID(), TenantID: tenantID, ParentSubscriptionID: parent.ID,
					Enabled: true, StartsAt: now,
				})
				if err := tx.Create(&item).Error; err != nil {
					return err
				}
			} else if err != nil {
				return err
			} else {
				item = canonicalBalanceGrant(parent, item)
				item.Enabled = true
				item.StartsAt = now
				if err := tx.Model(&ChildSubscription{}).Where("id = ?", item.ID).Updates(map[string]any{
					"name": item.Name, "allocation_ppm": item.AllocationPPM, "priority": item.Priority,
					"enabled": true, "model_allowlist": item.ModelAllowlist, "starts_at": item.StartsAt,
					"expires_at": nil, "updated_at": now,
				}).Error; err != nil {
					return err
				}
			}
			items = append(items, item)
		}
		return nil
	})
	return items, err
}

func canonicalBalanceGrant(parent ParentSubscription, item ChildSubscription) ChildSubscription {
	item.ParentSubscriptionID = parent.ID
	item.Name = parent.Name
	item.AllocationPPM = 1_000_000
	item.Priority = 100
	item.ModelAllowlist = pq.StringArray{}
	item.ExpiresAt = nil
	return item
}

func (s Store) ActiveSubscriptionModelGrants(ctx context.Context, tenantID string, now time.Time) ([]SubscriptionModelGrant, error) {
	type grantRow struct {
		ChildModels  pq.StringArray `gorm:"column:child_models;type:text[]"`
		ParentModels pq.StringArray `gorm:"column:parent_models;type:text[]"`
		CPAModels    pq.StringArray `gorm:"column:cpa_models;type:text[]"`
		CapacityMode string         `gorm:"column:capacity_mode"`
	}
	var rows []grantRow
	err := scoped(ctx, s.DB).Table("child_subscriptions").
		Select("child_subscriptions.model_allowlist AS child_models, parent_subscriptions.model_allowlist AS parent_models, parent_subscriptions.cpa_model_allowlist AS cpa_models, parent_subscriptions.capacity_mode AS capacity_mode").
		Joins("JOIN parent_subscriptions ON parent_subscriptions.id = child_subscriptions.parent_subscription_id").
		Where("child_subscriptions.tenant_id = ?", tenantID).
		Where("child_subscriptions.enabled = ? AND child_subscriptions.starts_at <= ? AND (child_subscriptions.expires_at IS NULL OR child_subscriptions.expires_at > ?)", true, now, now).
		Where("parent_subscriptions.enabled = ? AND parent_subscriptions.cpa_unavailable = ? AND parent_subscriptions.status <> ?", true, false, "missing").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	grants := make([]SubscriptionModelGrant, 0, len(rows))
	for _, row := range rows {
		childModels := row.ChildModels
		if row.CapacityMode == db.ParentCapacityUnmetered {
			childModels = nil
		}
		grants = append(grants, SubscriptionModelGrant{
			ChildModels: childModels, ParentModels: row.ParentModels, CPAModels: row.CPAModels,
		})
	}
	return grants, nil
}

func (grant SubscriptionModelGrant) AllowsModel(model string) bool {
	return modelAllowed(model, grant.ChildModels, grant.ParentModels, grant.CPAModels)
}

// AllowsModel treats active subscription assignments as additions to the
// tenant's available model pool. A non-empty API-key allowlist remains the
// final per-key switch, including for subscription models.
func (key KeyContext) AllowsModel(model string) bool {
	if modelAllowed(model, key.ModelAllowlist, key.TenantModels) {
		return true
	}
	if !modelAllowed(model, key.ModelAllowlist) {
		return false
	}
	for _, grant := range key.SubscriptionModelGrants {
		if grant.AllowsModel(model) {
			return true
		}
	}
	return false
}

func (s Store) SubscriptionCandidates(ctx context.Context, tenantID, model string, now time.Time) ([]SubscriptionCandidate, bool, error) {
	var children []ChildSubscription
	err := scoped(ctx, s.DB).
		Where("tenant_id = ? AND enabled = ? AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)", tenantID, true, now, now).
		Order("priority DESC, created_at").Find(&children).Error
	if err != nil {
		return nil, false, err
	}
	parentIDs := make([]string, 0, len(children))
	seenParents := make(map[string]struct{}, len(children))
	for _, child := range children {
		if _, exists := seenParents[child.ParentSubscriptionID]; exists {
			continue
		}
		seenParents[child.ParentSubscriptionID] = struct{}{}
		parentIDs = append(parentIDs, child.ParentSubscriptionID)
	}
	var parents []ParentSubscription
	if len(parentIDs) > 0 {
		if err := scoped(ctx, s.DB).Where("id IN ? AND status <> ?", parentIDs, "missing").Find(&parents).Error; err != nil {
			return nil, false, err
		}
	}
	parentsByID := make(map[string]ParentSubscription, len(parents))
	for _, parent := range parents {
		parentsByID[parent.ID] = parent
	}
	hasModelAssignment := false
	items := make([]SubscriptionCandidate, 0, len(children))
	for _, child := range children {
		parent, exists := parentsByID[child.ParentSubscriptionID]
		if !exists {
			continue
		}
		childModels := child.ModelAllowlist
		if parent.CapacityMode == db.ParentCapacityUnmetered {
			childModels = nil
		}
		if !modelAllowed(model, childModels, parent.ModelAllowlist, parent.CPAModelAllowlist) {
			continue
		}
		hasModelAssignment = true
		if !parent.Enabled || parent.CPAUnavailable {
			continue
		}
		items = append(items, SubscriptionCandidate{Child: child, Parent: parent})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Child.Priority > items[j].Child.Priority })
	return items, hasModelAssignment, nil
}

func (s Store) AdmitRequest(ctx context.Context, input AdmissionInput) (Admission, error) {
	now := time.Now()
	candidates, hasModelAssignment, err := s.SubscriptionCandidates(ctx, input.Key.TenantID, input.Model, now)
	if err != nil {
		return Admission{}, err
	}
	if len(candidates) == 0 {
		if hasModelAssignment {
			return Admission{}, ErrSubscriptionRequired
		}
		return s.reserveCandidate(ctx, input, nil)
	}
	var capacityErr error
	for _, candidate := range candidates {
		if candidate.Parent.CapacityMode != db.ParentCapacityUnmetered && !input.PriceConfigured {
			capacityErr = ErrSubscriptionPrice
			continue
		}
		admission, err := s.reserveCandidate(ctx, input, &candidate)
		if err == nil {
			return admission, nil
		}
		if errors.Is(err, ErrSubscriptionExhausted) {
			capacityErr = err
			continue
		}
		return Admission{}, err
	}
	if capacityErr != nil {
		return Admission{}, capacityErr
	}
	return Admission{}, ErrSubscriptionRequired
}

func (s Store) UpdateReservationPriceSnapshot(ctx context.Context, requestID string, snapshot json.RawMessage) error {
	if len(snapshot) == 0 {
		snapshot = json.RawMessage(`{}`)
	}
	result := scoped(ctx, s.DB).Model(&RequestReservation{}).
		Where("request_id = ? AND status = ?", requestID, db.ReservationActive).
		Update("price_snapshot", snapshot)
	if result.Error == nil && result.RowsAffected == 0 {
		return ErrNotFound
	}
	return result.Error
}

func (s Store) reserveCandidate(ctx context.Context, input AdmissionInput, candidate *SubscriptionCandidate) (Admission, error) {
	var result Admission
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var existing RequestReservation
		if err := tx.First(&existing, "request_id = ?", input.RequestID).Error; err == nil {
			result = admissionFromReservation(existing)
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		var tenant Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", input.Key.TenantID).Error; err != nil {
			return err
		}
		if !tenant.Enabled {
			return errors.New("insufficient balance")
		}

		reservation := RequestReservation{
			RequestID: input.RequestID, TenantID: input.Key.TenantID, APIKeyID: input.Key.ID,
			Model: input.Model, BalanceReservedNanoUSD: input.BalanceReserve,
			PriceSnapshot: input.PriceSnapshot, QuotaWindows: json.RawMessage(`[]`), Status: db.ReservationActive, ExpiresAt: input.ExpiresAt,
		}
		if len(reservation.PriceSnapshot) == 0 {
			reservation.PriceSnapshot = json.RawMessage(`{}`)
		}

		if candidate != nil {
			var child ChildSubscription
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&child, "id = ? AND enabled = ?", candidate.Child.ID, true).Error; err != nil {
				return ErrSubscriptionRequired
			}
			var parent ParentSubscription
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent,
				"id = ? AND enabled = ? AND cpa_unavailable = ?", child.ParentSubscriptionID, true, false).Error; err != nil {
				return ErrSubscriptionRequired
			}
			reservation.ChildSubscriptionID = &child.ID
			reservation.ParentSubscriptionID = &parent.ID
			reservation.CPAAuthID = parent.CPAAuthID
			reservation.CPAAuthIndex = parent.CPAAuthIndex
			if parent.CapacityMode != db.ParentCapacityUnmetered {
				if input.QuotaReserve <= 0 {
					return ErrSubscriptionPrice
				}
				var parentWindows []ParentQuotaWindow
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("parent_subscription_id = ?", parent.ID).Find(&parentWindows).Error; err != nil {
					return err
				}
				if len(parentWindows) == 0 {
					if parent.CapacityMode != db.ParentCapacityObserved || parent.QuotaProbeStatus == "unsupported" {
						return ErrSubscriptionExhausted
					}
				} else {
					// Once calibrated windows exist, charge child quota instead of
					// the tenant balance. Before that, learning mode keeps the
					// original balance reservation.
					reservation.BalanceReservedNanoUSD = 0
				}
				reservedWindows := make([]quotaWindowReservation, 0, len(parentWindows))
				for _, parentWindow := range parentWindows {
					limit := fraction(parentWindow.LimitNanoUSD, child.AllocationPPM)
					if limit <= 0 || !parentWindow.ResetsAt.After(time.Now()) {
						return ErrSubscriptionExhausted
					}
					var window ChildQuotaWindow
					err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&window,
						"child_subscription_id = ? AND kind = ?", child.ID, parentWindow.Kind).Error
					if err == nil && parentWindow.ResetsAt.Before(window.ResetsAt) {
						// Never let a stale upstream observation roll a child back
						// into an older generation and erase newer-cycle usage.
						return ErrSubscriptionExhausted
					}
					if errors.Is(err, gorm.ErrRecordNotFound) || !window.ResetsAt.Equal(parentWindow.ResetsAt) {
						window = ChildQuotaWindow{
							ChildSubscriptionID: child.ID, Kind: parentWindow.Kind, StartedAt: time.Now(),
							ResetsAt: parentWindow.ResetsAt, LimitNanoUSD: limit,
						}
						if err := tx.Clauses(clause.OnConflict{
							Columns:   []clause.Column{{Name: "child_subscription_id"}, {Name: "kind"}},
							DoUpdates: clause.AssignmentColumns([]string{"started_at", "resets_at", "limit_nano_usd", "settled_nano_usd", "reserved_nano_usd", "updated_at"}),
						}).Create(&window).Error; err != nil {
							return err
						}
					} else if err != nil {
						return err
					}
					if window.SettledNanoUSD+window.ReservedNanoUSD+input.QuotaReserve > limit {
						return ErrSubscriptionExhausted
					}
					if err := tx.Model(&ChildQuotaWindow{}).
						Where("child_subscription_id = ? AND kind = ?", child.ID, parentWindow.Kind).
						Updates(map[string]any{"limit_nano_usd": limit, "reserved_nano_usd": window.ReservedNanoUSD + input.QuotaReserve, "updated_at": time.Now()}).Error; err != nil {
						return err
					}
					reservedWindows = append(reservedWindows, quotaWindowReservation{Kind: parentWindow.Kind, ResetsAt: parentWindow.ResetsAt})
				}
				if len(reservedWindows) > 0 {
					reservation.QuotaReservedNanoUSD = input.QuotaReserve
					reservation.QuotaWindows, _ = json.Marshal(reservedWindows)
				}
			}
		}

		if tenant.BalanceNanoUSD < reservation.BalanceReservedNanoUSD {
			return errors.New("insufficient balance")
		}
		if reservation.BalanceReservedNanoUSD > 0 {
			tenant.BalanceNanoUSD -= reservation.BalanceReservedNanoUSD
			if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
				return err
			}
			if err := tx.Create(&db.BillingLedger{
				ID: identity.NewID(), TenantID: tenant.ID, RequestID: &input.RequestID, Kind: "reservation",
				AmountNanoUSD: -reservation.BalanceReservedNanoUSD, BalanceAfterNanoUSD: tenant.BalanceNanoUSD,
				Note: "request reserve",
			}).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(&reservation).Error; err != nil {
			return err
		}
		result = admissionFromReservation(reservation)
		return nil
	})
	return result, err
}

func (s Store) SettleRequestReservation(ctx context.Context, requestID string, actual int64, pricingComplete bool) error {
	return s.finishReservation(ctx, requestID, actual, pricingComplete, db.ReservationSettled)
}

// AccrueWebSocketTurn durably charges one terminal WebSocket response and
// writes its billing-entry log in the same transaction. Replayed terminal
// frames are ignored by the request_id + turn_id primary key.
func (s Store) AccrueWebSocketTurn(ctx context.Context, input WebSocketTurnAccrual) (bool, error) {
	inserted := false
	err := scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		var reservation RequestReservation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&reservation, "request_id = ?", input.RequestID).Error; err != nil {
			return notFound(err)
		}
		if reservation.Status != db.ReservationActive {
			return fmt.Errorf("request reservation is %s", reservation.Status)
		}
		turn := db.WebSocketTurn{
			RequestID: input.RequestID, TurnID: strings.TrimSpace(input.TurnID),
			PromptTokens: input.Usage.Prompt, CompletionTokens: input.Usage.Completion,
			CachedTokens: input.Usage.Cached, CacheWriteTokens: input.Usage.CacheWrite,
			ReasoningTokens: input.Usage.Reasoning, ImageInputTokens: input.Usage.ImageInput,
			CachedImageInputTokens: input.Usage.CachedImageInput, ImageOutputTokens: input.Usage.ImageOutput,
			TotalTokens: input.Usage.Total, CostNanoUSD: input.CostNanoUSD,
			PricingComplete: input.PricingComplete, CreatedAt: time.Now(),
		}
		if turn.TurnID == "" {
			return errors.New("websocket turn id is required")
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&turn)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		inserted = true

		usesBalance, err := reservationUsesBalance(tx, reservation)
		if err != nil {
			return err
		}
		if usesBalance && input.CostNanoUSD != 0 {
			var tenant Tenant
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", reservation.TenantID).Error; err != nil {
				return err
			}
			tenant.BalanceNanoUSD -= input.CostNanoUSD
			if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
				return err
			}
			requestID := reservation.RequestID
			if err := tx.Create(&db.BillingLedger{
				ID: identity.NewID(), TenantID: tenant.ID, RequestID: &requestID, Kind: "settlement",
				AmountNanoUSD: -input.CostNanoUSD, BalanceAfterNanoUSD: tenant.BalanceNanoUSD,
				Note: "websocket terminal turn settlement",
			}).Error; err != nil {
				return err
			}
		}
		if reservation.ChildSubscriptionID != nil && reservation.QuotaReservedNanoUSD > 0 && input.CostNanoUSD != 0 {
			var reservedWindows []quotaWindowReservation
			if err := json.Unmarshal(reservation.QuotaWindows, &reservedWindows); err != nil {
				return err
			}
			for _, reservedWindow := range reservedWindows {
				var window ChildQuotaWindow
				err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&window,
					"child_subscription_id = ? AND kind = ? AND resets_at = ?",
					*reservation.ChildSubscriptionID, reservedWindow.Kind, reservedWindow.ResetsAt).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				if err := tx.Model(&window).Update("settled_nano_usd", window.SettledNanoUSD+input.CostNanoUSD).Error; err != nil {
					return err
				}
			}
		}
		accrued := input.CostNanoUSD
		pricingComplete := input.PricingComplete
		if reservation.ActualNanoUSD != nil {
			accrued += *reservation.ActualNanoUSD
			pricingComplete = reservation.PricingComplete && input.PricingComplete
		}
		if err := tx.Model(&reservation).Updates(map[string]any{
			"actual_nano_usd": accrued, "pricing_complete": pricingComplete,
		}).Error; err != nil {
			return err
		}
		return writeLogTx(tx, input.Log, true)
	})
	if err != nil {
		return false, err
	}
	return inserted, err
}

func (s Store) ReleaseRequestReservation(ctx context.Context, requestID string) error {
	return s.finishReservation(ctx, requestID, 0, false, db.ReservationReleased)
}

func (s Store) ReclaimExpiredReservations(ctx context.Context, now time.Time) (int, error) {
	var reservations []RequestReservation
	if err := scoped(ctx, s.DB).Model(&RequestReservation{}).
		Where("status = ? AND expires_at <= ?", db.ReservationActive, now).
		Find(&reservations).Error; err != nil {
		return 0, err
	}
	reclaimed := 0
	for _, reservation := range reservations {
		actual := int64(0)
		if reservation.ActualNanoUSD != nil {
			actual = *reservation.ActualNanoUSD
		}
		if err := s.finishReservation(ctx, reservation.RequestID, actual, reservation.PricingComplete, db.ReservationExpired); err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return reclaimed, err
		}
		reclaimed++
	}
	return reclaimed, nil
}

func reservationUsesBalance(tx *gorm.DB, reservation RequestReservation) (bool, error) {
	if reservation.ParentSubscriptionID == nil {
		return true, nil
	}
	if reservation.QuotaReservedNanoUSD == 0 && reservation.BalanceReservedNanoUSD > 0 {
		return true, nil
	}
	var parent ParentSubscription
	if err := tx.Select("capacity_mode").First(&parent, "id = ?", *reservation.ParentSubscriptionID).Error; err != nil {
		return false, err
	}
	return parent.CapacityMode == db.ParentCapacityUnmetered, nil
}

func (s Store) finishReservation(ctx context.Context, requestID string, actual int64, pricingComplete bool, status string) error {
	return scoped(ctx, s.DB).Transaction(func(tx *gorm.DB) error {
		return finishReservationTx(tx, requestID, actual, pricingComplete, status)
	})
}

func finishReservationTx(tx *gorm.DB, requestID string, actual int64, pricingComplete bool, status string) error {
	var reservation RequestReservation
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&reservation, "request_id = ?", requestID).Error; err != nil {
		return notFound(err)
	}
	if reservation.Status != db.ReservationActive {
		return nil
	}
	var tenant Tenant
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", reservation.TenantID).Error; err != nil {
		return err
	}
	usesBalance, err := reservationUsesBalance(tx, reservation)
	if err != nil {
		return err
	}
	accrued := int64(0)
	if reservation.ActualNanoUSD != nil {
		accrued = *reservation.ActualNanoUSD
	}
	finalActual := int64(0)
	if status == db.ReservationSettled || status == db.ReservationExpired {
		finalActual = actual
	}
	balanceDelta := int64(0)
	if usesBalance {
		// The initial reserve and every durable WebSocket turn have already
		// been debited. Finalization only reconciles that held/accrued amount
		// to the final cumulative cost.
		balanceDelta = reservation.BalanceReservedNanoUSD + accrued - finalActual
	}
	if balanceDelta != 0 {
		tenant.BalanceNanoUSD += balanceDelta
		if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
			return err
		}
		if err := tx.Create(&db.BillingLedger{
			ID: identity.NewID(), TenantID: tenant.ID, RequestID: &requestID,
			Kind:          map[bool]string{true: "settlement", false: "refund"}[status == db.ReservationSettled],
			AmountNanoUSD: balanceDelta, BalanceAfterNanoUSD: tenant.BalanceNanoUSD,
			Note: "request reservation finalized",
		}).Error; err != nil {
			return err
		}
	}
	if reservation.ChildSubscriptionID != nil && reservation.QuotaReservedNanoUSD > 0 {
		var reservedWindows []quotaWindowReservation
		if err := json.Unmarshal(reservation.QuotaWindows, &reservedWindows); err != nil {
			return err
		}
		quotaDelta := finalActual - accrued
		for _, reservedWindow := range reservedWindows {
			var window ChildQuotaWindow
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&window,
				"child_subscription_id = ? AND kind = ? AND resets_at = ?",
				*reservation.ChildSubscriptionID, reservedWindow.Kind, reservedWindow.ResetsAt).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// A later admission has advanced this kind to a new upstream
				// generation. Never charge the old request to that new window.
				continue
			}
			if err != nil {
				return err
			}
			reserved := window.ReservedNanoUSD - reservation.QuotaReservedNanoUSD
			if reserved < 0 {
				reserved = 0
			}
			settled := window.SettledNanoUSD + quotaDelta
			if settled < 0 {
				settled = 0
			}
			if err := tx.Model(&ChildQuotaWindow{}).
				Where("child_subscription_id = ? AND kind = ?", window.ChildSubscriptionID, window.Kind).
				Updates(map[string]any{
					"reserved_nano_usd": reserved,
					"settled_nano_usd":  settled,
					"updated_at":        time.Now(),
				}).Error; err != nil {
				return err
			}
		}
	}
	now := time.Now()
	actualValue := finalActual
	return tx.Model(&reservation).Updates(map[string]any{
		"actual_nano_usd": &actualValue, "pricing_complete": pricingComplete,
		"status": status, "settled_at": &now,
	}).Error
}

func reconcileSettledReservation(tx *gorm.DB, requestID string, actual int64) error {
	var reservation RequestReservation
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&reservation, "request_id = ?", requestID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if reservation.Status != db.ReservationSettled {
		return nil
	}
	previous := int64(0)
	if reservation.ActualNanoUSD != nil {
		previous = *reservation.ActualNanoUSD
	}
	costDelta := previous - actual
	usesBalance, err := reservationUsesBalance(tx, reservation)
	if err != nil {
		return err
	}
	balanceDelta := int64(0)
	if usesBalance {
		balanceDelta = costDelta
	}
	if balanceDelta != 0 {
		var tenant Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&tenant, "id = ?", reservation.TenantID).Error; err != nil {
			return err
		}
		tenant.BalanceNanoUSD += balanceDelta
		if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
			return err
		}
		if err := tx.Create(&db.BillingLedger{
			ID: identity.NewID(), TenantID: tenant.ID, RequestID: &requestID, Kind: "reconciliation",
			AmountNanoUSD: balanceDelta, BalanceAfterNanoUSD: tenant.BalanceNanoUSD, Note: "pricing backfill reconciliation",
		}).Error; err != nil {
			return err
		}
	}
	if reservation.ChildSubscriptionID != nil && costDelta != 0 {
		var windows []quotaWindowReservation
		if err := json.Unmarshal(reservation.QuotaWindows, &windows); err != nil {
			return err
		}
		for _, reservedWindow := range windows {
			var window ChildQuotaWindow
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&window,
				"child_subscription_id = ? AND kind = ? AND resets_at = ?",
				*reservation.ChildSubscriptionID, reservedWindow.Kind, reservedWindow.ResetsAt).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			settled := window.SettledNanoUSD - costDelta
			if settled < 0 {
				settled = 0
			}
			if err := tx.Model(&window).Update("settled_nano_usd", settled).Error; err != nil {
				return err
			}
		}
	}
	return tx.Model(&reservation).Updates(map[string]any{
		"actual_nano_usd": actual, "pricing_complete": true,
	}).Error
}

func (s Store) ChildQuotaState(ctx context.Context, childID string) ([]ChildQuotaWindow, error) {
	var items []ChildQuotaWindow
	err := scoped(ctx, s.DB).Where("child_subscription_id = ?", childID).Order("kind").Find(&items).Error
	return items, err
}

func (s Store) ProjectedChildQuotaState(ctx context.Context, child ChildSubscription) ([]ChildQuotaWindow, error) {
	parentWindows, err := s.ListParentQuotaWindows(ctx, child.ParentSubscriptionID)
	if err != nil {
		return nil, err
	}
	current, err := s.ChildQuotaState(ctx, child.ID)
	if err != nil {
		return nil, err
	}
	byKind := make(map[string]ChildQuotaWindow, len(current))
	for _, window := range current {
		byKind[window.Kind] = window
	}
	result := make([]ChildQuotaWindow, 0, len(parentWindows))
	for _, parentWindow := range parentWindows {
		window := ChildQuotaWindow{
			ChildSubscriptionID: child.ID,
			Kind:                parentWindow.Kind,
			StartedAt:           time.Now(),
			ResetsAt:            parentWindow.ResetsAt,
			LimitNanoUSD:        fraction(parentWindow.LimitNanoUSD, child.AllocationPPM),
		}
		if existing, ok := byKind[parentWindow.Kind]; ok && existing.ResetsAt.Equal(parentWindow.ResetsAt) {
			window = existing
			window.LimitNanoUSD = fraction(parentWindow.LimitNanoUSD, child.AllocationPPM)
		}
		result = append(result, window)
	}
	return result, nil
}

func (s Store) HasActiveChildSubscriptions(ctx context.Context, now time.Time) (bool, error) {
	var count int64
	err := scoped(ctx, s.DB).Model(&ChildSubscription{}).
		Joins("JOIN parent_subscriptions ON parent_subscriptions.id = child_subscriptions.parent_subscription_id").
		Where("child_subscriptions.enabled = ? AND child_subscriptions.starts_at <= ? AND (child_subscriptions.expires_at IS NULL OR child_subscriptions.expires_at > ?)", true, now, now).
		Where("parent_subscriptions.enabled = ? AND parent_subscriptions.cpa_unavailable = ? AND parent_subscriptions.status <> ?", true, false, "missing").
		Count(&count).Error
	return count > 0, err
}

func admissionFromReservation(value RequestReservation) Admission {
	result := Admission{
		RequestID: value.RequestID, CPAAuthID: value.CPAAuthID, CPAAuthIndex: value.CPAAuthIndex,
		BalanceReservedNanoUSD: value.BalanceReservedNanoUSD,
		QuotaReservedNanoUSD:   value.QuotaReservedNanoUSD,
	}
	if value.ParentSubscriptionID != nil {
		result.ParentSubscriptionID = *value.ParentSubscriptionID
	}
	if value.ChildSubscriptionID != nil {
		result.ChildSubscriptionID = *value.ChildSubscriptionID
	}
	return result
}

func fraction(value, ppm int64) int64 {
	if value <= 0 || ppm <= 0 {
		return 0
	}
	result := new(big.Int).Mul(big.NewInt(value), big.NewInt(ppm))
	result.Div(result, big.NewInt(1_000_000))
	if !result.IsInt64() {
		return int64(^uint64(0) >> 1)
	}
	return result.Int64()
}

func percentageCapacity(costNanoUSD, deltaMicros int64) int64 {
	if costNanoUSD <= 0 || deltaMicros <= 0 {
		return 0
	}
	result := new(big.Int).Mul(big.NewInt(costNanoUSD), big.NewInt(100_000_000))
	result.Div(result, big.NewInt(deltaMicros))
	if !result.IsInt64() {
		return int64(^uint64(0) >> 1)
	}
	return result.Int64()
}

func medianInt64(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	items := append([]int64(nil), values...)
	sort.Slice(items, func(i, j int) bool { return items[i] < items[j] })
	middle := len(items) / 2
	if len(items)%2 == 1 {
		return items[middle]
	}
	left := big.NewInt(items[middle-1])
	left.Add(left, big.NewInt(items[middle]))
	left.Div(left, big.NewInt(2))
	if !left.IsInt64() {
		return int64(^uint64(0) >> 1)
	}
	return left.Int64()
}

func modelAllowed(model string, lists ...[]string) bool {
	for _, list := range lists {
		if len(list) == 0 {
			continue
		}
		matchedList := false
		for _, pattern := range list {
			matched, _ := path.Match(strings.ToLower(pattern), strings.ToLower(model))
			if pattern == "*" || strings.EqualFold(pattern, model) || matched {
				matchedList = true
				break
			}
		}
		if !matchedList {
			return false
		}
	}
	return true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "Parent subscription"
}
