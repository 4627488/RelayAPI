package cpa

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

func probeAntigravityQuota(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(firstQuotaValue(document["access_token"], document["accessToken"]))
	if token == "" {
		return QuotaReport{}, errors.New("Antigravity quota credential is missing access_token")
	}
	headers := http.Header{
		"Accept":            {"application/json"},
		"Authorization":     {"Bearer " + token},
		"Content-Type":      {"application/json"},
		"User-Agent":        {"antigravity/hub/2.2.1 darwin/arm64"},
		"X-Goog-Api-Client": {"gl-node/22.21.1"},
	}
	project := antigravityProjectID(document)
	plan := firstQuotaText(scalarQuotaText(document["plan_type"]), scalarQuotaText(document["tier"]))
	if strings.TrimSpace(endpoints.antigravityLoad) != "" {
		load, err := requestQuotaJSONBody(ctx, client, http.MethodPost, endpoints.antigravityLoad, headers, map[string]any{
			"metadata": map[string]any{"ideType": "ANTIGRAVITY"},
		})
		if err == nil {
			loadRoot := quotaPayloadRoot(load)
			project = firstQuotaText(antigravityProjectID(loadRoot), project)
			plan = firstQuotaText(antigravityPlanType(loadRoot), plan)
		}
	}
	body := map[string]any{}
	if project != "" {
		body["project"] = project
	}
	var payload map[string]any
	modelErrors := make([]string, 0, len(endpoints.antigravityModels))
	for _, endpoint := range endpoints.antigravityModels {
		if strings.TrimSpace(endpoint) == "" {
			continue
		}
		value, err := requestQuotaJSONBody(ctx, client, http.MethodPost, endpoint, headers, body)
		if err != nil {
			modelErrors = append(modelErrors, err.Error())
			continue
		}
		if models, _ := quotaPayloadRoot(value)["models"].(map[string]any); len(models) == 0 {
			modelErrors = append(modelErrors, "response contains no models")
			continue
		}
		payload = value
		break
	}
	if payload == nil {
		return QuotaReport{}, fmt.Errorf("Antigravity quota requests failed: %s", strings.Join(modelErrors, "; "))
	}
	models, _ := quotaPayloadRoot(payload)["models"].(map[string]any)
	windows := make([]QuotaWindow, 0, len(models))
	for model, raw := range models {
		info := quotaMap(raw)
		if quotaBool(info["isInternal"]) || strings.EqualFold(scalarQuotaText(info["apiProvider"]), "API_PROVIDER_INTERNAL") {
			continue
		}
		quota := quotaMap(firstQuotaValue(info["quotaInfo"], info["quota_info"]))
		if quota == nil {
			continue
		}
		remaining := numericQuota(firstQuotaValue(quota["remainingFraction"], quota["remaining_fraction"]))
		if remaining == nil {
			continue
		}
		remainingPercent := *remaining
		if remainingPercent <= 1 {
			remainingPercent *= 100
		}
		remainingPercent = clampQuota(remainingPercent)
		usedPercent := clampQuota(100 - remainingPercent)
		window := QuotaWindow{
			Kind:             "model-" + quotaSlug(model),
			Label:            firstQuotaText(scalarQuotaText(info["displayName"]), scalarQuotaText(info["display_name"]), model),
			UsedPercent:      &usedPercent,
			RemainingPercent: &remainingPercent,
			ResetsAt:         parseQuotaTime(firstQuotaValue(quota["resetTime"], quota["reset_time"]), now),
			Enforceable:      false,
		}
		windows = append(windows, window)
	}
	windows = validQuotaWindows(windows, now)
	sort.SliceStable(windows, func(i, j int) bool {
		left, right := windows[i].RemainingPercent, windows[j].RemainingPercent
		if left != nil && right != nil && *left != *right {
			return *left < *right
		}
		if left == nil && right != nil {
			return false
		}
		if left != nil && right == nil {
			return true
		}
		return windows[i].Label < windows[j].Label
	})
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("Antigravity quota response contains no usable model windows")
	}
	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  plan,
		Supported: true,
		Source:    "antigravity-models",
		Observed:  now,
		Windows:   windows,
	}, nil
}

func antigravityProjectID(value map[string]any) string {
	for _, key := range []string{"project_id", "projectId", "project", "cloudaicompanionProject"} {
		switch typed := value[key].(type) {
		case string:
			if result := strings.TrimSpace(typed); result != "" {
				return result
			}
		case map[string]any:
			if result := strings.TrimSpace(scalarQuotaText(typed["id"])); result != "" {
				return result
			}
		}
	}
	return ""
}

func antigravityPlanType(value map[string]any) string {
	for _, key := range []string{"paidTier", "currentTier"} {
		if current := quotaMap(value[key]); current != nil {
			if result := firstQuotaText(scalarQuotaText(current["name"]), scalarQuotaText(current["id"])); result != "" {
				return result
			}
		}
	}
	if rows, _ := value["allowedTiers"].([]any); rows != nil {
		for _, raw := range rows {
			tier := quotaMap(raw)
			if tier != nil && quotaBool(tier["isDefault"]) {
				if result := firstQuotaText(scalarQuotaText(tier["name"]), scalarQuotaText(tier["id"])); result != "" {
					return result
				}
			}
		}
	}
	return ""
}
