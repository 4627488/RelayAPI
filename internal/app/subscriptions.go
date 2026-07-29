package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

type parentSubscriptionInput struct {
	Name               string   `json:"name"`
	PlanType           string   `json:"plan_type"`
	CapacityMode       string   `json:"capacity_mode"`
	AllocationLimitPPM int64    `json:"allocation_limit_ppm"`
	Enabled            bool     `json:"enabled"`
	ModelAllowlist     []string `json:"model_allowlist"`
}

type childSubscriptionInput struct {
	TenantID             string   `json:"tenant_id"`
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
	Kind         string   `json:"kind"`
	LimitNanoUSD int64    `json:"limit_nano_usd"`
	ResetsAt     string   `json:"resets_at"`
	Source       string   `json:"source"`
	UsedPercent  *float64 `json:"observed_used_percent"`
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
			for _, child := range children {
				if child.ParentSubscriptionID == item.ID && child.Enabled {
					allocated += child.AllocationPPM
				}
			}
			result = append(result, map[string]any{"item": item, "windows": windows, "allocated_ppm": allocated})
		}
		writeJSON(w, 200, map[string]any{"items": result})
		return
	}
	var input struct {
		CPAAuthID    string `json:"cpa_auth_id"`
		CPAAuthIndex string `json:"cpa_auth_index"`
		CPAAuthName  string `json:"cpa_auth_name"`
		Provider     string `json:"provider"`
		parentSubscriptionInput
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.CPAAuthID) == "" || !validCapacityMode(input.CapacityMode) {
		writeError(w, 400, "validation_error", "CPA AuthID 和有效容量模式必填")
		return
	}
	item, err := a.store.UpsertParentSubscription(r.Context(), store.ParentSubscription{
		CPAAuthID: input.CPAAuthID, CPAAuthIndex: input.CPAAuthIndex, CPAAuthName: input.CPAAuthName, Provider: input.Provider,
		Name: input.Name, PlanType: input.PlanType, CapacityMode: input.CapacityMode,
		AllocationLimitPPM: input.AllocationLimitPPM, Enabled: input.Enabled, ModelAllowlist: input.ModelAllowlist,
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
	if !validCapacityMode(input.CapacityMode) || input.AllocationLimitPPM <= 0 {
		writeError(w, 400, "validation_error", "容量模式或分配上限无效")
		return
	}
	item, err := a.store.UpdateParentSubscription(r.Context(), store.ParentSubscription{
		ID: r.PathValue("id"), Name: input.Name, PlanType: input.PlanType,
		CapacityMode: input.CapacityMode, AllocationLimitPPM: input.AllocationLimitPPM,
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
		resetsAt, err := time.Parse(time.RFC3339, value.ResetsAt)
		if err != nil {
			writeError(w, 400, "validation_error", "额度窗口重置时间无效")
			return
		}
		now := time.Now()
		windows = append(windows, store.ParentQuotaWindow{
			Kind: value.Kind, LimitNanoUSD: value.LimitNanoUSD, ResetsAt: resetsAt,
			Source: value.Source, ObservedUsedPercent: value.UsedPercent, ObservedAt: &now,
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
	if !a.requireCPAManagement(w) {
		return
	}
	syncStartedAt := time.Now()
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, "auth-files", nil)
	if err != nil || status < 200 || status >= 300 {
		writeError(w, 502, "cpa_unavailable", "无法同步 CPA 凭据")
		return
	}
	var response map[string]any
	if json.Unmarshal(payload, &response) != nil {
		writeError(w, 502, "invalid_cpa_response", "CPA 凭据响应无效")
		return
	}
	rows, ok := response["files"].([]any)
	if !ok {
		writeError(w, 502, "invalid_cpa_response", "CPA 凭据列表字段无效")
		return
	}
	items := make([]store.ParentSubscription, 0, len(rows))
	seen := make([]string, 0, len(rows))
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		authID := firstString(row, "id", "name")
		authIndex := firstString(row, "auth_index", "authIndex", "AuthIndex")
		if authIndex == "" {
			authIndex = authID
		}
		name := firstString(row, "name", "file")
		if authID == "" || authIndex == "" {
			continue
		}
		provider := firstString(row, "provider", "type")
		display := firstString(row, "label", "email", "name")
		models, modelsOK := a.cpaAuthModels(r, name)
		if !modelsOK {
			if existing, existingErr := a.store.GetParentSubscriptionByCPAAuthIndex(r.Context(), authIndex); existingErr == nil {
				models = existing.CPAModelAllowlist
			}
		}
		now := time.Now()
		statusValue := firstString(row, "status")
		if statusValue == "" {
			statusValue = "available"
		}
		enabled := !boolField(row, "disabled") && !boolField(row, "unavailable")
		item, err := a.store.SyncParentSubscription(r.Context(), store.ParentSubscription{
			CPAAuthID: authID, CPAAuthIndex: authIndex, CPAAuthName: name, Name: display, Provider: provider,
			PlanType: firstString(row, "plan_type", "plan", "account_type"), Status: statusValue,
			CapacityMode: db.ParentCapacityUnmetered, AllocationLimitPPM: 1_000_000,
			Enabled: true, CPAUnavailable: !enabled, CPAModelAllowlist: models, Metadata: json.RawMessage(`{}`), LastSyncedAt: &now,
		})
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		items = append(items, item)
		seen = append(seen, authIndex)
	}
	if err := a.store.MarkMissingParentSubscriptions(r.Context(), seen, syncStartedAt); err != nil {
		writeError(w, 500, "database_error", err.Error())
		return
	}
	a.refreshBridgeStatus(r.Context())
	writeJSON(w, 200, map[string]any{"items": items, "synced": len(items)})
}

func (a *App) cpaAuthModels(r *http.Request, name string) ([]string, bool) {
	if strings.TrimSpace(name) == "" {
		return nil, false
	}
	status, payload, err := a.cpa.Management(r.Context(), http.MethodGet, "auth-files/models?name="+url.QueryEscape(name), nil)
	if err != nil || status < 200 || status >= 300 {
		return nil, false
	}
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return nil, false
	}
	return extractModels(value), true
}

func (a *App) adminChildSubscriptions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := a.store.ListChildSubscriptions(r.Context(), strings.TrimSpace(r.URL.Query().Get("tenant_id")))
		if err != nil {
			writeError(w, 500, "database_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var input childSubscriptionInput
	if !decodeJSON(w, r, &input) {
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
	for _, item := range items {
		parent, err := a.store.GetParentSubscription(r.Context(), item.ParentSubscriptionID)
		if err != nil {
			writeSubscriptionError(w, err)
			return
		}
		windows := []store.ChildQuotaWindow(nil)
		if parent.CapacityMode != db.ParentCapacityUnmetered {
			windows, err = a.store.ProjectedChildQuotaState(r.Context(), item)
			if err != nil {
				writeError(w, 500, "database_error", err.Error())
				return
			}
		}
		result = append(result, map[string]any{
			"id": item.ID, "name": item.Name, "allocation_ppm": item.AllocationPPM,
			"priority": item.Priority, "enabled": item.Enabled, "model_allowlist": item.ModelAllowlist,
			"starts_at": item.StartsAt, "expires_at": item.ExpiresAt, "capacity_mode": parent.CapacityMode, "windows": windows,
		})
	}
	writeJSON(w, 200, map[string]any{"items": result})
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
	return value == db.ParentCapacityUnmetered || value == db.ParentCapacityManual || value == db.ParentCapacityObserved
}

func writeSubscriptionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, 404, "not_found", "订阅不存在")
	case errors.Is(err, store.ErrAllocationExceeded):
		writeError(w, 409, "allocation_exceeded", "子订阅总分配超过父订阅上限")
	default:
		writeError(w, 400, "subscription_error", err.Error())
	}
}

func firstString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if raw, ok := value[key]; ok && raw != nil {
			text := strings.TrimSpace(fmt.Sprint(raw))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func boolField(value map[string]any, key string) bool {
	result, _ := value[key].(bool)
	return result
}

func extractModels(value any) []string {
	if object, ok := value.(map[string]any); ok {
		for _, key := range []string{"models", "items", "data"} {
			if nested, exists := object[key]; exists {
				return extractModels(nested)
			}
		}
	}
	rows, _ := value.([]any)
	result := make([]string, 0, len(rows))
	for _, row := range rows {
		switch item := row.(type) {
		case string:
			if strings.TrimSpace(item) != "" {
				result = append(result, strings.TrimSpace(item))
			}
		case map[string]any:
			if name := firstString(item, "id", "name", "model"); name != "" {
				result = append(result, name)
			}
		}
	}
	return result
}
