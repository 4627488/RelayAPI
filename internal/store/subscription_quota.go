package store

import (
	"context"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

// SubscriptionQuota contains only the user's share, never upstream account metadata.
type SubscriptionQuota struct {
	ChildID       string
	Name          string
	Provider      string
	Models        []string
	Unavailable   bool
	BalanceBilled bool
	ExpiresAt     *time.Time
	Windows       []ChildQuotaWindow
}

// SubscriptionQuotas projects active, model-visible grants in four batch reads.
// Unavailable grants stay visible so a temporary outage is not mistaken for no plan.
// Models must be concrete runtime model IDs, so glob allowlists retain admission semantics.
func (s Store) SubscriptionQuotas(ctx context.Context, key KeyContext, models []string, now time.Time) ([]SubscriptionQuota, error) {
	var children []ChildSubscription
	if err := scoped(ctx, s.DB).Where("tenant_id = ? AND enabled = ? AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)", key.TenantID, true, now, now).Order("id").Find(&children).Error; err != nil {
		return nil, err
	}
	result := make([]SubscriptionQuota, 0)
	if len(children) == 0 {
		return result, nil
	}
	parentIDs := make([]string, 0, len(children))
	for _, c := range children {
		parentIDs = append(parentIDs, c.ParentSubscriptionID)
	}
	var parents []ParentSubscription
	if err := scoped(ctx, s.DB).Where("id IN ?", parentIDs).Find(&parents).Error; err != nil {
		return nil, err
	}
	byParent := make(map[string]ParentSubscription, len(parents))
	for _, p := range parents {
		byParent[p.ID] = p
	}
	eligible := make([]ChildSubscription, 0, len(children))
	modelsByChild := make(map[string][]string, len(children))
	childIDs := make([]string, 0, len(children))
	for _, c := range children {
		p, ok := byParent[c.ParentSubscriptionID]
		if !ok {
			continue
		}
		childModels := c.ModelAllowlist
		if p.CapacityMode == db.ParentCapacityUnmetered {
			childModels = nil
		}
		for _, model := range models {
			if key.AllowsModel(model) && modelAllowed(model, childModels, p.ModelAllowlist, p.UpstreamModelAllowlist) {
				modelsByChild[c.ID] = append(modelsByChild[c.ID], model)
			}
		}
		if len(modelsByChild[c.ID]) > 0 {
			eligible = append(eligible, c)
			childIDs = append(childIDs, c.ID)
		}
	}
	if len(eligible) == 0 {
		return result, nil
	}
	var parentWindows []ParentQuotaWindow
	if err := scoped(ctx, s.DB).Where("parent_subscription_id IN ?", parentIDs).Order("kind").Find(&parentWindows).Error; err != nil {
		return nil, err
	}
	var current []ChildQuotaWindow
	if err := scoped(ctx, s.DB).Where("child_subscription_id IN ?", childIDs).Find(&current).Error; err != nil {
		return nil, err
	}
	windowsByParent := make(map[string][]ParentQuotaWindow)
	for _, w := range parentWindows {
		windowsByParent[w.ParentSubscriptionID] = append(windowsByParent[w.ParentSubscriptionID], w)
	}
	existing := make(map[[2]string]ChildQuotaWindow, len(current))
	for _, w := range current {
		existing[[2]string{w.ChildSubscriptionID, w.Kind}] = w
	}
	for _, c := range eligible {
		p := byParent[c.ParentSubscriptionID]
		q := SubscriptionQuota{ChildID: c.ID, Name: c.Name, Provider: p.Provider, ExpiresAt: c.ExpiresAt,
			Unavailable:   !p.Enabled || p.UpstreamUnavailable || p.Status == "missing",
			BalanceBilled: p.CapacityMode == db.ParentCapacityUnmetered}
		q.Models = modelsByChild[c.ID]
		if q.BalanceBilled {
			result = append(result, q)
			continue
		}
		for _, pw := range windowsByParent[c.ParentSubscriptionID] {
			w := ChildQuotaWindow{ChildSubscriptionID: c.ID, Kind: pw.Kind, StartedAt: now, ResetsAt: pw.ResetsAt}
			if old, ok := existing[[2]string{c.ID, pw.Kind}]; ok {
				if old.ResetsAt.Equal(pw.ResetsAt) {
					w = old
				} else if old.ResetsAt.After(pw.ResetsAt) {
					// Admission refuses observations from an older generation too.
					q.Unavailable = true
				}
			}
			w.LimitNanoUSD = pw.LimitNanoUSD
			if pw.LimitNanoUSD >= 0 {
				w.LimitNanoUSD = fraction(pw.LimitNanoUSD, c.AllocationPPM)
			}
			q.Windows = append(q.Windows, w)
		}
		result = append(result, q)
	}
	return result, nil
}
