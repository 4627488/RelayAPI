package store

import (
	"context"
	"time"
)

// SubscriptionQuota contains only the user's share, never upstream account metadata.
type SubscriptionQuota struct {
	ChildID  string
	Name     string
	Provider string
	Windows  []ChildQuotaWindow
}

// SubscriptionQuotas projects all usable active grants in four bounded batch reads.
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
	if err := scoped(ctx, s.DB).Where("id IN ? AND enabled = ? AND upstream_unavailable = ? AND status <> ? AND capacity_mode = ?", parentIDs, true, false, "missing", "observed").Find(&parents).Error; err != nil {
		return nil, err
	}
	byParent := make(map[string]ParentSubscription, len(parents))
	for _, p := range parents {
		byParent[p.ID] = p
	}
	eligible := make([]ChildSubscription, 0, len(children))
	childIDs := make([]string, 0, len(children))
	for _, c := range children {
		p, ok := byParent[c.ParentSubscriptionID]
		if !ok {
			continue
		}
		for _, model := range models {
			if key.AllowsModel(model) && modelAllowed(model, key.ModelAllowlist, c.ModelAllowlist, p.ModelAllowlist, p.UpstreamModelAllowlist) {
				eligible = append(eligible, c)
				childIDs = append(childIDs, c.ID)
				break
			}
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
		q := SubscriptionQuota{ChildID: c.ID, Name: c.Name, Provider: byParent[c.ParentSubscriptionID].Provider}
		for _, pw := range windowsByParent[c.ParentSubscriptionID] {
			if pw.LimitNanoUSD < 0 {
				continue
			}
			w := ChildQuotaWindow{ChildSubscriptionID: c.ID, Kind: pw.Kind, StartedAt: now, ResetsAt: pw.ResetsAt}
			if old, ok := existing[[2]string{c.ID, pw.Kind}]; ok && old.ResetsAt.Equal(pw.ResetsAt) {
				w = old
			}
			w.LimitNanoUSD = fraction(pw.LimitNanoUSD, c.AllocationPPM)
			q.Windows = append(q.Windows, w)
		}
		result = append(result, q)
	}
	return result, nil
}
