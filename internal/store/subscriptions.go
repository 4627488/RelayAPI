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
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrAllocationExceeded    = errors.New("parent subscription allocation exceeded")
	ErrSubscriptionRequired  = errors.New("no eligible child subscription")
	ErrSubscriptionExhausted = errors.New("child subscription quota exhausted")
	ErrSubscriptionPrice     = errors.New("priced model is required for metered subscription")
)

// Upstream rolling-window reset timestamps are often derived from a rounded
// countdown and can move by a few seconds between probes. Treat nearby values
// as the same generation; a real reset advances by hours or days.
const quotaResetJitterTolerance = time.Minute

type ParentSubscription = db.ParentSubscription
type ParentQuotaWindow = db.ParentQuotaWindow
type ParentQuotaObservation = db.ParentQuotaObservation
type ChildSubscription = db.ChildSubscription
type ChildQuotaWindow = db.ChildQuotaWindow
type RequestReservation = db.RequestReservation

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

type quotaWindowReservation struct {
	Kind     string    `json:"kind"`
	ResetsAt time.Time `json:"resets_at"`
}

func (s Store) ListParentSubscriptions(ctx context.Context) ([]ParentSubscription, error) {
	var items []ParentSubscription
	err := scoped(ctx, s.DB).Order("created_at DESC").Find(&items).Error
	return items, err
}

func (s Store) GetParentSubscription(ctx context.Context, id string) (ParentSubscription, error) {
	var item ParentSubscription
	err := scoped(ctx, s.DB).First(&item, "id = ?", id).Error
	return item, notFound(err)
}

func (s Store) GetParentSubscriptionByCPAAuthIndex(ctx context.Context, authIndex string) (ParentSubscription, error) {
	var item ParentSubscription
	err := scoped(ctx, s.DB).First(&item, "cpa_auth_index = ?", strings.TrimSpace(authIndex)).Error
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
	if item.AllocationLimitPPM <= 0 {
		item.AllocationLimitPPM = 1_000_000
	}
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
	query := scoped(ctx, s.DB).Model(&ParentSubscription{}).
		Where("last_synced_at IS NOT NULL AND last_synced_at < ?", syncStartedAt)
	if len(seen) > 0 {
		query = query.Where("cpa_auth_index NOT IN ?", seen)
	}
	return query.Updates(map[string]any{
		"cpa_unavailable": true,
		"status":          "missing",
		"updated_at":      time.Now(),
	}).Error
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
		if item.AllocationLimitPPM <= 0 {
			return errors.New("allocation_limit_ppm must be positive")
		}
		if enforcesAllocationLimit(item.CapacityMode) {
			var allocated int64
			if err := tx.Model(&ChildSubscription{}).
				Where("parent_subscription_id = ? AND enabled = ?", item.ID, true).
				Select("COALESCE(sum(allocation_ppm), 0)").Scan(&allocated).Error; err != nil {
				return err
			}
			if allocated > item.AllocationLimitPPM {
				return ErrAllocationExceeded
			}
		}
		return tx.Model(&current).Updates(map[string]any{
			"name": strings.TrimSpace(item.Name), "plan_type": strings.TrimSpace(item.PlanType),
			"capacity_mode": item.CapacityMode, "allocation_limit_ppm": item.AllocationLimitPPM,
			"enabled": item.Enabled, "model_allowlist": item.ModelAllowlist, "updated_at": time.Now(),
		}).Error
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
		kinds := make([]string, 0, len(windows))
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
		deleteQuery := tx.Where("parent_subscription_id = ?", parentID)
		if len(kinds) > 0 {
			deleteQuery = deleteQuery.Where("kind NOT IN ?", kinds)
		}
		if err := deleteQuery.Delete(&ParentQuotaWindow{}).Error; err != nil {
			return err
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
				deltaMicros := int64(math.Round((usedPercent - previous.UsedPercent) * 1_000_000))
				// Upstream providers commonly expose one or two decimal places. A
				// 0.01% movement is enough for a differential sample; the rolling
				// median below rejects isolated noisy estimates.
				if deltaMicros < 10_000 {
					observation.Reason = "percentage_delta_too_small"
				} else {
					type totals struct {
						Cost       int64
						Incomplete int64
					}
					var total totals
					if err := tx.Model(&db.RequestLog{}).Select(
						"COALESCE(sum(cost_nano_usd),0) AS cost, COALESCE(sum(CASE WHEN pricing_complete = false AND model <> '' THEN 1 ELSE 0 END),0) AS incomplete",
					).Where("auth_index = ? AND started_at > ? AND started_at <= ?", parent.CPAAuthIndex, previous.ObservedAt, observedAt).
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
			var estimates []int64
			if err := tx.Model(&ParentQuotaObservation{}).
				Where("parent_subscription_id = ? AND kind = ? AND accepted = ? AND estimated_limit IS NOT NULL", parentID, observation.Kind, true).
				Order("observed_at DESC").Limit(21).Pluck("estimated_limit", &estimates).Error; err != nil {
				return err
			}
			limit = medianInt64(estimates)
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
	query := scoped(ctx, s.DB).Order("priority DESC, created_at DESC")
	if tenantID != "" {
		query = query.Where("tenant_id = ?", tenantID)
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
		if item.Enabled && (!parent.Enabled || parent.CPAUnavailable) {
			return errors.New("enabled child subscription requires an available parent")
		}
		var tenant Tenant
		if err := tx.First(&tenant, "id = ?", item.TenantID).Error; err != nil {
			return notFound(err)
		}
		if item.Enabled && enforcesAllocationLimit(parent.CapacityMode) {
			var allocated int64
			if err := tx.Model(&ChildSubscription{}).
				Where("parent_subscription_id = ? AND enabled = ?", item.ParentSubscriptionID, true).
				Select("COALESCE(sum(allocation_ppm), 0)").Scan(&allocated).Error; err != nil {
				return err
			}
			if allocated+item.AllocationPPM > parent.AllocationLimitPPM {
				return ErrAllocationExceeded
			}
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
		if item.Enabled && (!parent.Enabled || parent.CPAUnavailable) {
			return errors.New("enabled child subscription requires an available parent")
		}
		if item.Enabled && enforcesAllocationLimit(parent.CapacityMode) {
			var allocated int64
			if err := tx.Model(&ChildSubscription{}).
				Where("parent_subscription_id = ? AND enabled = ? AND id <> ?", item.ParentSubscriptionID, true, item.ID).
				Select("COALESCE(sum(allocation_ppm), 0)").Scan(&allocated).Error; err != nil {
				return err
			}
			if allocated+item.AllocationPPM > parent.AllocationLimitPPM {
				return ErrAllocationExceeded
			}
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

// Unmetered parents represent credentials such as pay-as-you-go upstream API
// keys. Their children are access grants, not slices of a finite upstream
// quota, so any number of tenants may share them while each tenant continues
// to settle usage against its own account balance.
func enforcesAllocationLimit(capacityMode string) bool {
	return capacityMode != db.ParentCapacityUnmetered
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
		if err := scoped(ctx, s.DB).Where("id IN ?", parentIDs).Find(&parents).Error; err != nil {
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
		if !modelAllowed(model, child.ModelAllowlist, parent.ModelAllowlist, parent.CPAModelAllowlist) {
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

func (s Store) ReleaseRequestReservation(ctx context.Context, requestID string) error {
	return s.finishReservation(ctx, requestID, 0, false, db.ReservationReleased)
}

func (s Store) ReclaimExpiredReservations(ctx context.Context, now time.Time) (int, error) {
	var requestIDs []string
	if err := scoped(ctx, s.DB).Model(&RequestReservation{}).
		Where("status = ? AND expires_at <= ?", db.ReservationActive, now).
		Pluck("request_id", &requestIDs).Error; err != nil {
		return 0, err
	}
	reclaimed := 0
	for _, requestID := range requestIDs {
		if err := s.finishReservation(ctx, requestID, 0, false, db.ReservationExpired); err != nil {
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
		balanceActual := int64(0)
		if status == db.ReservationSettled && usesBalance {
			balanceActual = actual
		} else if status != db.ReservationSettled {
			balanceActual = 0
		}
		delta := reservation.BalanceReservedNanoUSD - balanceActual
		if delta != 0 {
			tenant.BalanceNanoUSD += delta
			if err := tx.Model(&tenant).Update("balance_nano_usd", tenant.BalanceNanoUSD).Error; err != nil {
				return err
			}
			if err := tx.Create(&db.BillingLedger{
				ID: identity.NewID(), TenantID: tenant.ID, RequestID: &requestID,
				Kind:          map[bool]string{true: "settlement", false: "refund"}[status == db.ReservationSettled],
				AmountNanoUSD: delta, BalanceAfterNanoUSD: tenant.BalanceNanoUSD,
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
			quotaActual := actual
			if status != db.ReservationSettled {
				quotaActual = 0
			}
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
				if err := tx.Model(&ChildQuotaWindow{}).
					Where("child_subscription_id = ? AND kind = ?", window.ChildSubscriptionID, window.Kind).
					Updates(map[string]any{
						"reserved_nano_usd": reserved,
						"settled_nano_usd":  window.SettledNanoUSD + quotaActual,
						"updated_at":        time.Now(),
					}).Error; err != nil {
					return err
				}
			}
		}
		now := time.Now()
		actualValue := actual
		return tx.Model(&reservation).Updates(map[string]any{
			"actual_nano_usd": &actualValue, "pricing_complete": pricingComplete,
			"status": status, "settled_at": &now,
		}).Error
	})
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
		Where("enabled = ? AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)", true, now, now).
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
