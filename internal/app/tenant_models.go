package app

import (
	"net/http"
	"sort"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

type tenantModelSettlement struct {
	Mode             string `json:"mode"`
	SubscriptionID   string `json:"subscription_id,omitempty"`
	SubscriptionName string `json:"subscription_name,omitempty"`
	Available        bool   `json:"available"`
}

type tenantModelView struct {
	ID          string                  `json:"id"`
	Settlements []tenantModelSettlement `json:"settlements"`
}

type tenantModelGrant struct {
	parent  store.ParentSubscription
	child   store.ChildSubscription
	windows []store.ParentQuotaWindow
	state   []store.ChildQuotaWindow
}

func (a *App) tenantModels(w http.ResponseWriter, r *http.Request) {
	if a.nativeRuntime == nil {
		writeError(w, http.StatusServiceUnavailable, "model_catalog_unavailable", "模型目录暂不可用")
		return
	}
	tenantID := currentSession(r).TenantID
	tenant, err := a.store.GetTenant(r.Context(), tenantID)
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	children, err := a.store.ListChildSubscriptions(r.Context(), tenantID)
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	now := time.Now()
	grants := make([]tenantModelGrant, 0, len(children))
	parents := make(map[string]store.ParentSubscription)
	windows := make(map[string][]store.ParentQuotaWindow)
	for _, child := range children {
		if !child.Enabled || child.StartsAt.After(now) || (child.ExpiresAt != nil && !child.ExpiresAt.After(now)) {
			continue
		}
		parent, cached := parents[child.ParentSubscriptionID]
		if !cached {
			parent, err = a.store.GetParentSubscription(r.Context(), child.ParentSubscriptionID)
			if err != nil {
				writeSubscriptionError(w, err)
				return
			}
			parents[parent.ID] = parent
		}
		grant := tenantModelGrant{parent: parent, child: child}
		if parent.CapacityMode == db.ParentCapacityObserved {
			parentWindows, cached := windows[parent.ID]
			if !cached {
				parentWindows, err = a.store.ListParentQuotaWindows(r.Context(), parent.ID)
				if err != nil {
					writeSubscriptionError(w, err)
					return
				}
				windows[parent.ID] = parentWindows
			}
			grant.windows = parentWindows
			grant.state, err = a.store.ProjectedChildQuotaState(r.Context(), child)
			if err != nil {
				writeSubscriptionError(w, err)
				return
			}
		}
		grants = append(grants, grant)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": projectTenantModels(a.nativeRuntime.Models(), tenant.ModelAllowlist, grants, now)})
}

func projectTenantModels(models, tenantModels []string, grants []tenantModelGrant, now time.Time) []tenantModelView {
	result := make([]tenantModelView, 0, len(models))
	base := store.KeyContext{TenantModels: tenantModels}
	for _, model := range normalizedModels(models) {
		item := tenantModelView{ID: model, Settlements: []tenantModelSettlement{}}
		balanceIndex := -1
		for _, grant := range grants {
			parent, child := grant.parent, grant.child
			if !child.Enabled || child.StartsAt.After(now) || (child.ExpiresAt != nil && !child.ExpiresAt.After(now)) {
				continue
			}
			childModels := child.ModelAllowlist
			if parent.CapacityMode == db.ParentCapacityUnmetered {
				childModels = nil
			}
			entitlement := store.SubscriptionModelGrant{ChildModels: childModels, ParentModels: parent.ModelAllowlist, UpstreamModels: parent.UpstreamModelAllowlist}
			if !entitlement.AllowsModel(model) {
				continue
			}
			available, _ := tenantSubscriptionAvailability(parent, child, now)
			available = available && parent.Status != "missing"
			if parent.CapacityMode == db.ParentCapacityObserved && len(grant.windows) == 0 && parent.QuotaProbeStatus == "unsupported" {
				available = false
			}
			option := tenantModelSettlement{Mode: "balance", Available: available}
			if parent.CapacityMode == db.ParentCapacityObserved && len(grant.windows) > 0 {
				option.Mode, option.SubscriptionID, option.SubscriptionName = "subscription", child.ID, tenantSubscriptionName(parent, child)
				for _, window := range projectTenantEntitlements(grant.windows, child, grant.state) {
					if window.RemainingNanoUSD <= 0 || !window.ResetsAt.After(now) {
						option.Available = false
					}
				}
			} else if balanceIndex >= 0 {
				item.Settlements[balanceIndex].Available = item.Settlements[balanceIndex].Available || option.Available
				continue
			} else {
				balanceIndex = len(item.Settlements)
			}
			item.Settlements = append(item.Settlements, option)
		}
		// A claimed model must never imply an unconfigured balance fallback.
		if len(item.Settlements) == 0 && base.AllowsModel(model) {
			item.Settlements = append(item.Settlements, tenantModelSettlement{Mode: "balance", Available: true})
		}
		if len(item.Settlements) > 0 {
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
