package app

import (
	"encoding/json"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/cpa"
	"github.com/4627488/RelayAPI/internal/store"
)

type tenantEntitlementWindow struct {
	Kind                          string     `json:"kind"`
	Label                         string     `json:"label"`
	Unit                          string     `json:"unit,omitempty"`
	AllocationPPM                 int64      `json:"allocation_ppm"`
	ShareOfParentPercent          float64    `json:"share_of_parent_percent"`
	AvailableShareOfParentPercent *float64   `json:"available_share_of_parent_percent,omitempty"`
	ParentLimit                   *float64   `json:"parent_limit,omitempty"`
	AllocatedLimit                *float64   `json:"allocated_limit,omitempty"`
	ParentRemaining               *float64   `json:"parent_remaining,omitempty"`
	AllocatedRemaining            *float64   `json:"allocated_remaining,omitempty"`
	UpstreamUsedPercent           *float64   `json:"upstream_used_percent,omitempty"`
	UpstreamRemainingPercent      *float64   `json:"upstream_remaining_percent,omitempty"`
	ResetsAt                      *time.Time `json:"resets_at,omitempty"`
	Enforceable                   bool       `json:"enforceable"`
}

func projectTenantEntitlements(parent store.ParentSubscription, child store.ChildSubscription) []tenantEntitlementWindow {
	var report cpa.QuotaReport
	if len(parent.QuotaSnapshot) == 0 || json.Unmarshal(parent.QuotaSnapshot, &report) != nil {
		return []tenantEntitlementWindow{}
	}
	share := float64(child.AllocationPPM) / 1_000_000
	sharePercent := share * 100
	result := make([]tenantEntitlementWindow, 0, len(report.Windows))
	for _, source := range report.Windows {
		remainingPercent := source.RemainingPercent
		if remainingPercent == nil && source.UsedPercent != nil {
			value := max(0, min(100, 100-*source.UsedPercent))
			remainingPercent = &value
		}
		window := tenantEntitlementWindow{
			Kind: source.Kind, Label: source.Label, Unit: source.Unit,
			AllocationPPM: child.AllocationPPM, ShareOfParentPercent: sharePercent,
			UpstreamUsedPercent: source.UsedPercent, UpstreamRemainingPercent: remainingPercent,
			ResetsAt: source.ResetsAt, Enforceable: source.Enforceable,
		}
		if window.Label == "" {
			window.Label = window.Kind
		}
		if source.Limit != nil {
			window.ParentLimit = floatPointer(*source.Limit)
			window.AllocatedLimit = floatPointer(*source.Limit * share)
		}
		if source.Remaining != nil {
			window.ParentRemaining = floatPointer(*source.Remaining)
			window.AllocatedRemaining = floatPointer(*source.Remaining * share)
		}
		if remainingPercent != nil {
			window.AvailableShareOfParentPercent = floatPointer(sharePercent * *remainingPercent / 100)
		}
		result = append(result, window)
	}
	return result
}

func effectiveSubscriptionModels(parent store.ParentSubscription, child store.ChildSubscription) ([]string, string) {
	source := "cpa"
	if len(parent.ModelAllowlist) > 0 {
		source = "parent"
	}
	if len(child.ModelAllowlist) > 0 {
		source = "child"
	}
	if len(parent.CPAModelAllowlist) == 0 {
		var candidates []string
		switch {
		case allConcreteModels(parent.ModelAllowlist):
			candidates = parent.ModelAllowlist
		case allConcreteModels(child.ModelAllowlist):
			candidates = child.ModelAllowlist
		}
		result := make([]string, 0, len(candidates))
		for _, model := range candidates {
			if matchesModelList(model, parent.ModelAllowlist) && matchesModelList(model, child.ModelAllowlist) {
				result = append(result, model)
			}
		}
		return normalizedModels(result), source
	}
	result := make([]string, 0, len(parent.CPAModelAllowlist))
	for _, model := range parent.CPAModelAllowlist {
		if matchesModelList(model, parent.ModelAllowlist) && matchesModelList(model, child.ModelAllowlist) {
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

func floatPointer(value float64) *float64 {
	return &value
}
