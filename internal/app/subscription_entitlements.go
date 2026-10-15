package app

import (
	"path"
	"sort"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

type tenantEntitlementWindow struct {
	Kind                string     `json:"kind"`
	AllocationPPM       int64      `json:"allocation_ppm"`
	ParentLimitNanoUSD  int64      `json:"parent_limit_nano_usd"`
	LimitNanoUSD        int64      `json:"limit_nano_usd"`
	SettledNanoUSD      int64      `json:"settled_nano_usd"`
	ReservedNanoUSD     int64      `json:"reserved_nano_usd"`
	RemainingNanoUSD    int64      `json:"remaining_nano_usd"`
	UpstreamUsedPercent *float64   `json:"upstream_used_percent,omitempty"`
	ResetsAt            time.Time  `json:"resets_at"`
	Source              string     `json:"source"`
	ObservedAt          *time.Time `json:"observed_at,omitempty"`
}

func projectTenantSubscription(parent store.ParentSubscription, child store.ChildSubscription, parentWindows []store.ParentQuotaWindow, windows []store.ChildQuotaWindow, resets []tenantQuotaReset, now time.Time) map[string]any {
	models, modelSource := effectiveSubscriptionModels(parent, child)
	available, message := tenantSubscriptionAvailability(parent, child, now)
	if available && parent.CapacityMode == db.ParentCapacityObserved && len(parentWindows) == 0 && parent.QuotaProbeStatus == "unsupported" {
		available, message = false, "订阅额度暂不可用，请联系管理员"
	}
	billingMode := "balance"
	if parent.CapacityMode != db.ParentCapacityUnmetered && len(parentWindows) > 0 {
		billingMode = "quota"
	}
	return map[string]any{
		"id": child.ID, "name": tenantSubscriptionName(parent, child), "allocation_ppm": child.AllocationPPM,
		"priority": child.Priority, "enabled": child.Enabled, "model_allowlist": child.ModelAllowlist,
		"starts_at": child.StartsAt, "expires_at": child.ExpiresAt, "capacity_mode": parent.CapacityMode, "windows": windows,
		"available": available, "availability_message": message,
		"billing_mode": billingMode, "parent_quota_probe_status": parent.QuotaProbeStatus,
		"parent_quota_observed_at":  parent.QuotaObservedAt,
		"effective_model_allowlist": models, "model_source": modelSource,
		"entitlement_windows": projectTenantEntitlements(parentWindows, child, windows),
		"reset_history":       resets,
	}
}

func tenantSubscriptionName(parent store.ParentSubscription, child store.ChildSubscription) string {
	name := strings.TrimSpace(child.Name)
	// Legacy balance grants copied the credential name. Do not expose that identity.
	if name == "" || name == parent.Name || name == parent.UpstreamCredentialName || name == parent.UpstreamCredentialID || strings.Contains(name, "@") {
		return "模型订阅"
	}
	return name
}

func projectTenantEntitlements(parent []store.ParentQuotaWindow, child store.ChildSubscription, state []store.ChildQuotaWindow) []tenantEntitlementWindow {
	byKind := make(map[string]store.ChildQuotaWindow, len(state))
	for _, window := range state {
		byKind[window.Kind] = window
	}
	result := make([]tenantEntitlementWindow, 0, len(parent))
	for _, source := range parent {
		window := byKind[source.Kind]
		used := window.SettledNanoUSD + window.ReservedNanoUSD
		remaining := window.LimitNanoUSD - used
		if remaining < 0 {
			remaining = 0
		}
		result = append(result, tenantEntitlementWindow{
			Kind: source.Kind, AllocationPPM: child.AllocationPPM,
			ParentLimitNanoUSD: source.LimitNanoUSD, LimitNanoUSD: window.LimitNanoUSD,
			SettledNanoUSD: window.SettledNanoUSD, ReservedNanoUSD: window.ReservedNanoUSD,
			RemainingNanoUSD: remaining, UpstreamUsedPercent: source.ObservedUsedPercent,
			ResetsAt: source.ResetsAt, Source: source.Source, ObservedAt: source.ObservedAt,
		})
	}
	return result
}

func effectiveSubscriptionModels(parent store.ParentSubscription, child store.ChildSubscription) ([]string, string) {
	childModels := child.ModelAllowlist
	if parent.CapacityMode == db.ParentCapacityUnmetered {
		childModels = nil
	}
	source := "upstream"
	if len(parent.ModelAllowlist) > 0 {
		source = "parent"
	}
	if len(childModels) > 0 {
		source = "child"
	}
	if len(parent.UpstreamModelAllowlist) == 0 {
		var candidates []string
		switch {
		case allConcreteModels(parent.ModelAllowlist):
			candidates = parent.ModelAllowlist
		case allConcreteModels(childModels):
			candidates = childModels
		}
		result := make([]string, 0, len(candidates))
		for _, model := range candidates {
			if matchesModelList(model, parent.ModelAllowlist) && matchesModelList(model, childModels) {
				result = append(result, model)
			}
		}
		return normalizedModels(result), source
	}
	result := make([]string, 0, len(parent.UpstreamModelAllowlist))
	for _, model := range parent.UpstreamModelAllowlist {
		if matchesModelList(model, parent.ModelAllowlist) && matchesModelList(model, childModels) {
			result = append(result, model)
		}
	}
	return normalizedModels(result), source
}

func allConcreteModels(models []string) bool {
	if len(models) == 0 {
		return false
	}
	for _, model := range models {
		if strings.ContainsAny(model, "*?[") {
			return false
		}
	}
	return true
}

func matchesModelList(model string, patterns []string) bool {
	if len(patterns) == 0 {
		return true
	}
	model = strings.ToLower(strings.TrimSpace(model))
	for _, raw := range patterns {
		pattern := strings.ToLower(strings.TrimSpace(raw))
		matched, _ := path.Match(pattern, model)
		if pattern == "*" || pattern == model || matched {
			return true
		}
	}
	return false
}

func normalizedModels(models []string) []string {
	seen := make(map[string]struct{}, len(models))
	result := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		key := strings.ToLower(model)
		if model == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, model)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}
