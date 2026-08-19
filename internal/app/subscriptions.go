package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

type parentSubscriptionInput struct {
	Name           string   `json:"name"`
	PlanType       string   `json:"plan_type"`
	CapacityMode   string   `json:"capacity_mode"`
	Enabled        bool     `json:"enabled"`
	ModelAllowlist []string `json:"model_allowlist"`
}

type childSubscriptionInput struct {
	TenantID             string   `json:"tenant_id"`
	TenantIDs            []string `json:"tenant_ids"`
	ParentSubscriptionID string   `json:"parent_subscription_id"`
	Name                 string   `json:"name"`
	AllocationPPM        int64    `json:"allocation_ppm"`
	Priority             int      `json:"priority"`
	Enabled              bool     `json:"enabled"`
	ModelAllowlist       []string `json:"model_allowlist"`
	StartsAt             string   `json:"starts_at"`
	ExpiresAt            string   `json:"expires_at"`
}

type quotaWindowInput struct {
	Kind         string `json:"kind"`
	LimitNanoUSD int64  `json:"limit_nano_usd"`
}

type adminChildSubscriptionView struct {
	store.ChildSubscription
	CapacityMode       string                    `json:"capacity_mode"`
	ParentName         string                    `json:"parent_name"`
	EntitlementWindows []tenantEntitlementWindow `json:"entitlement_windows"`
}

func (a *App) adminParentSubscriptions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListParentSubscriptions(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		children, err := a.store.ListChildSubscriptions(r.Context(), "")
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		result := make([]map[string]any, 0, len(items))
		for _, item := range items {
			windows, err := a.store.ListParentQuotaWindows(r.Context(), item.ID)
			if err != nil {
				writeError(w, 500, "database_error", err.Error())
				return
			}
			allocated := int64(0)
			if item.CapacityMode != db.ParentCapacityUnmetered {
				for _, child := range children {
					if child.ParentSubscriptionID == item.ID && child.Enabled {
						allocated += child.AllocationPPM
					}
				}
			}
			result = append(result, map[string]any{"item": item, "windows": windows, "allocated_ppm": allocated})
		}
		writeJSON(w, 200, map[string]any{"items": result})
		return
	}
	var input struct {
		UpstreamCredentialID   string `json:"upstream_credential_id"`
		UpstreamAuthIndex      string `json:"upstream_auth_index"`
		UpstreamCredentialName string `json:"upstream_credential_name"`
		Provider               string `json:"provider"`
		parentSubscriptionInput
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.UpstreamCredentialID) == "" || !validCapacityMode(input.CapacityMode) {
		writeError(w, 400, "validation_error", "Upstream AuthID 和有效容量模式必填")
		return
	}
	item, err := a.store.UpsertParentSubscription(r.Context(), store.ParentSubscription{
		UpstreamCredentialID: input.UpstreamCredentialID, UpstreamAuthIndex: input.UpstreamAuthIndex, UpstreamCredentialName: input.UpstreamCredentialName, Provider: input.Provider,
		Name: input.Name, PlanType: input.PlanType, CapacityMode: input.CapacityMode,
		AllocationLimitPPM: 1_000_000, Enabled: input.Enabled, ModelAllowlist: input.ModelAllowlist,
	})
	if err != nil {
		writeError(w, 409, "parent_subscription_failed", err.Error())
		return
	}
	writeJSON(w, 201, item)
}

func (a *App) adminParentSubscriptionUpdate(w http.ResponseWriter, r *http.Request) {
	var input parentSubscriptionInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if !validCapacityMode(input.CapacityMode) {
		writeError(w, 400, "validation_error", "容量模式无效")
		return
	}
	current, err := a.store.GetParentSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	item, err := a.store.UpdateParentSubscription(r.Context(), store.ParentSubscription{
		ID: r.PathValue("id"), Name: input.Name, PlanType: current.PlanType,
		CapacityMode: input.CapacityMode, AllocationLimitPPM: 1_000_000,
		Enabled: input.Enabled, ModelAllowlist: input.ModelAllowlist,
	})
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	writeJSON(w, 200, item)
}

func (a *App) adminParentWindows(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListParentQuotaWindows(r.Context(), r.PathValue("id"))
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input struct {
		Items []quotaWindowInput `json:"items"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	parent, err := a.store.GetParentSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	if parent.CapacityMode != db.ParentCapacityObserved {
		writeError(w, 400, "validation_error", "只有自动观测模式可以配置窗口 USD 转换")
		return
	}
	var snapshot struct {
		Windows []struct {
			Kind        string     `json:"kind"`
			UsedPercent *float64   `json:"used_percent"`
			ResetsAt    *time.Time `json:"resets_at"`
			Enforceable bool       `json:"enforceable"`
		} `json:"windows"`
	}
	if err := json.Unmarshal(parent.QuotaSnapshot, &snapshot); err != nil {
		writeError(w, 409, "quota_snapshot_invalid", "自动观测快照无效，请先重新同步上游额度")
		return
	}
	observed := make(map[string]struct {
		usedPercent *float64
		resetsAt    time.Time
	}, len(snapshot.Windows))
	for _, item := range snapshot.Windows {
		kind := strings.TrimSpace(item.Kind)
		if kind != "" && item.Enforceable && item.ResetsAt != nil {
			observed[kind] = struct {
				usedPercent *float64
				resetsAt    time.Time
			}{usedPercent: item.UsedPercent, resetsAt: *item.ResetsAt}
		}
	}
	windows := make([]store.ParentQuotaWindow, 0, len(input.Items))
	seenKinds := make(map[string]struct{}, len(input.Items))
	for _, value := range input.Items {
		value.Kind = strings.TrimSpace(value.Kind)
		if value.Kind == "" {
			writeError(w, 400, "validation_error", "额度窗口名称不能为空")
			return
		}
		if _, exists := seenKinds[value.Kind]; exists {
			writeError(w, 400, "validation_error", "额度窗口名称不能重复")
			return
		}
		seenKinds[value.Kind] = struct{}{}
		upstream, exists := observed[value.Kind]
		if !exists {
			writeError(w, 400, "validation_error", "额度窗口必须来自最新的自动观测快照")
			return
		}
		now := time.Now()
		windows = append(windows, store.ParentQuotaWindow{
			Kind: value.Kind, LimitNanoUSD: value.LimitNanoUSD, ResetsAt: upstream.resetsAt,
			Source: db.ParentQuotaSourceManualConversion, ObservedUsedPercent: upstream.usedPercent, ObservedAt: &now,
		})
	}
	if err := a.store.SetParentQuotaWindows(r.Context(), r.PathValue("id"), windows); err != nil {
		writeSubscriptionError(w, err)
		return
	}
	items, _ := a.store.ListParentQuotaWindows(r.Context(), r.PathValue("id"))
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *App) adminParentObservations(w http.ResponseWriter, r *http.Request) {
	parentID := r.PathValue("id")
	if r.Method == http.MethodGet {
		items, err := a.store.ListParentQuotaObservations(r.Context(), parentID, 100)
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input struct {
		Kind        string  `json:"kind"`
		UsedPercent float64 `json:"used_percent"`
		ResetsAt    string  `json:"resets_at"`
		ObservedAt  string  `json:"observed_at"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	resetsAt, err := time.Parse(time.RFC3339, input.ResetsAt)
	if err != nil {
		writeError(w, 400, "validation_error", "重置时间无效")
		return
	}
	observedAt := time.Now()
	if input.ObservedAt != "" {
		if observedAt, err = time.Parse(time.RFC3339, input.ObservedAt); err != nil {
			writeError(w, 400, "validation_error", "观测时间无效")
			return
		}
	}
	item, err := a.store.RecordParentQuotaObservation(r.Context(), parentID, input.Kind, input.UsedPercent, resetsAt, observedAt)
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	writeJSON(w, 201, item)
}

func (a *App) adminSyncParentSubscriptions(w http.ResponseWriter, r *http.Request) {
	a.syncNativeParentSubscriptions(w, r)
}

func (a *App) syncNativeParentSubscriptions(w http.ResponseWriter, r *http.Request) {
	items, err := a.syncNativeParentSubscriptionRows(r.Context())
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "synced": len(items), "quota": map[string]any{"mode": "native"}})
}

func (a *App) syncNativeParentSubscriptionRows(ctx context.Context) ([]store.ParentSubscription, error) {
	syncStartedAt := time.Now()
	rows, err := a.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]store.ParentSubscription, 0, len(rows))
	seen := make([]string, 0, len(rows))
	for _, row := range rows {
		status := "available"
		if !row.Enabled {
			status = "disabled"
		}
		now := time.Now()
		item, syncErr := a.store.SyncNativeParentSubscription(ctx, store.ParentSubscription{
			UpstreamCredentialID: row.ID, UpstreamAuthIndex: row.ID, UpstreamCredentialName: row.ID, Name: row.Name, Provider: row.Provider,
			PlanType: "native", Status: status, CapacityMode: db.ParentCapacityUnmetered, AllocationLimitPPM: 1_000_000,
			Enabled: true, UpstreamUnavailable: !row.Enabled, UpstreamModelAllowlist: row.Models, Metadata: json.RawMessage(`{"source":"native"}`), LastSyncedAt: &now,
		})
		if syncErr != nil {
			return nil, syncErr
		}
		items = append(items, item)
		seen = append(seen, row.ID)
	}
	if err = a.store.MarkMissingParentSubscriptions(ctx, seen, syncStartedAt); err != nil {
		return nil, err
	}
	return items, nil
}

func (a *App) adminChildSubscriptions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListChildSubscriptions(r.Context(), strings.TrimSpace(r.URL.Query().Get("tenant_id")))
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		parents, err := a.store.ListParentSubscriptions(r.Context())
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		parentsByID := make(map[string]store.ParentSubscription, len(parents))
		for _, parent := range parents {
			parentsByID[parent.ID] = parent
		}
		parentWindowsByID := make(map[string][]store.ParentQuotaWindow)
		result := make([]adminChildSubscriptionView, 0, len(items))
		for _, item := range items {
			parent, ok := parentsByID[item.ParentSubscriptionID]
			if !ok {
				continue
			}
			view := adminChildSubscriptionView{
				ChildSubscription:  item,
				CapacityMode:       parent.CapacityMode,
				ParentName:         parent.Name,
				EntitlementWindows: []tenantEntitlementWindow{},
			}
			if parent.CapacityMode != db.ParentCapacityUnmetered {
				parentWindows, cached := parentWindowsByID[parent.ID]
				if !cached {
					parentWindows, err = a.store.ListParentQuotaWindows(r.Context(), parent.ID)
					if err != nil {
						writeError(w, 500, "database_error", err.Error())
						return
					}
					parentWindowsByID[parent.ID] = parentWindows
				}
				childWindows, stateErr := a.store.ProjectedChildQuotaState(r.Context(), item)
				if stateErr != nil {
					writeError(w, 500, "database_error", stateErr.Error())
					return
				}
				view.EntitlementWindows = projectTenantEntitlements(parentWindows, item, childWindows)
			}
			result = append(result, view)
		}
		writeJSON(w, 200, map[string]any{"items": result})
		return
	}
	var input childSubscriptionInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.TenantIDs) > 0 {
		items, err := a.store.GrantBalanceSubscriptionAccess(r.Context(), input.ParentSubscriptionID, input.TenantIDs)
		if err != nil {
			writeSubscriptionError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"items": items})
		return
	}
	item, err := a.store.CreateChildSubscription(r.Context(), childFromInput("", input))
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	writeJSON(w, 201, item)
}

func (a *App) adminChildSubscription(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		if err := a.store.DeleteChildSubscription(r.Context(), r.PathValue("id")); err != nil {
			writeSubscriptionError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var input childSubscriptionInput
	if !decodeJSON(w, r, &input) {
		return
	}
	item, err := a.store.UpdateChildSubscription(r.Context(), childFromInput(r.PathValue("id"), input))
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	writeJSON(w, 200, item)
}

func (a *App) tenantSubscriptions(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListChildSubscriptions(r.Context(), currentSession(r).TenantID)
	if err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	result := make([]map[string]any, 0, len(items))
	now := time.Now()
	for _, item := range items {
		parent, err := a.store.GetParentSubscription(r.Context(), item.ParentSubscriptionID)
		if err != nil {
			writeSubscriptionError(w, err)
			return
		}
		windows := []store.ChildQuotaWindow(nil)
		parentWindows := []store.ParentQuotaWindow(nil)
		if parent.CapacityMode != db.ParentCapacityUnmetered {
			windows, err = a.store.ProjectedChildQuotaState(r.Context(), item)
			if err != nil {
				writeError(w, 500, "database_error", err.Error())
				return
			}
			parentWindows, err = a.store.ListParentQuotaWindows(r.Context(), parent.ID)
			if err != nil {
				writeError(w, 500, "database_error", err.Error())
				return
			}
		}
		models, modelSource := effectiveSubscriptionModels(parent, item)
		available, availabilityMessage := tenantSubscriptionAvailability(parent, item, now)
		if available && parent.CapacityMode == db.ParentCapacityObserved && len(parentWindows) == 0 && parent.QuotaProbeStatus == "unsupported" {
			available = false
			availabilityMessage = "父订阅无法读取额度，请联系管理员"
		}
		billingMode := "balance"
		if parent.CapacityMode != db.ParentCapacityUnmetered && len(parentWindows) > 0 {
			billingMode = "quota"
		}
		result = append(result, map[string]any{
			"id": item.ID, "name": item.Name, "allocation_ppm": item.AllocationPPM,
			"priority": item.Priority, "enabled": item.Enabled, "model_allowlist": item.ModelAllowlist,
			"starts_at": item.StartsAt, "expires_at": item.ExpiresAt, "capacity_mode": parent.CapacityMode, "windows": windows,
			"parent_name": parent.Name, "parent_plan_type": parent.PlanType,
			"available": available, "availability_message": availabilityMessage,
			"billing_mode": billingMode, "parent_quota_probe_status": parent.QuotaProbeStatus,
			"parent_quota_observed_at":  parent.QuotaObservedAt,
			"effective_model_allowlist": models, "model_source": modelSource,
			"entitlement_windows": projectTenantEntitlements(parentWindows, item, windows),
		})
	}
	writeJSON(w, 200, map[string]any{"items": result})
}

func tenantSubscriptionAvailability(parent store.ParentSubscription, child store.ChildSubscription, now time.Time) (bool, string) {
	switch {
	case !child.Enabled:
		return false, "子订阅已停用"
	case child.StartsAt.After(now):
		return false, "子订阅尚未开始"
	case child.ExpiresAt != nil && !child.ExpiresAt.After(now):
		return false, "子订阅已过期"
	case !parent.Enabled:
		return false, "父订阅已停用"
	case parent.UpstreamUnavailable:
		return false, "上游账户当前不可用"
	default:
		return true, ""
	}
}

func childFromInput(id string, input childSubscriptionInput) store.ChildSubscription {
	startsAt := time.Now()
	if parsed, err := time.Parse(time.RFC3339, input.StartsAt); err == nil {
		startsAt = parsed
	}
	var expiresAt *time.Time
	if parsed, err := time.Parse(time.RFC3339, input.ExpiresAt); err == nil {
		expiresAt = &parsed
	}
	return store.ChildSubscription{
		ID: id, TenantID: input.TenantID, ParentSubscriptionID: input.ParentSubscriptionID,
		Name: input.Name, AllocationPPM: input.AllocationPPM, Priority: input.Priority,
		Enabled: input.Enabled, ModelAllowlist: input.ModelAllowlist,
		StartsAt: startsAt, ExpiresAt: expiresAt,
	}
}

func validCapacityMode(value string) bool {
	return value == db.ParentCapacityUnmetered || value == db.ParentCapacityObserved
}

func writeSubscriptionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, 404, "not_found", "订阅不存在")
	default:
		writeError(w, 400, "subscription_error", err.Error())
	}
}
