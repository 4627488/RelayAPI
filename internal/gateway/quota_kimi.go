package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func probeKimiQuota(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(firstQuotaValue(document["access_token"], document["accessToken"], document["api_key"], document["apiKey"]))
	if token == "" {
		return QuotaReport{}, errors.New("Kimi quota credential is missing access_token")
	}
	headers := http.Header{
		"Accept":        {"application/json"},
		"Authorization": {"Bearer " + token},
		"User-Agent":    {"RelayAPI-KimiMonitor/1.0"},
	}
	var payload map[string]any
	var source string
	errorsByEndpoint := make([]string, 0, 2)
	for _, candidate := range []struct {
		endpoint string
		source   string
	}{
		{endpoint: endpoints.kimiUsage, source: "kimi-cn-usage"},
		{endpoint: endpoints.kimiUsageFallback, source: "kimi-global-usage"},
	} {
		if strings.TrimSpace(candidate.endpoint) == "" {
			continue
		}
		value, err := requestQuotaJSON(ctx, client, candidate.endpoint, headers)
		if err != nil {
			errorsByEndpoint = append(errorsByEndpoint, fmt.Sprintf("%s: %v", candidate.source, err))
			continue
		}
		root := quotaPayloadRoot(value)
		if root["usage"] == nil && root["limits"] == nil {
			errorsByEndpoint = append(errorsByEndpoint, candidate.source+": response contains no usage or limits")
			continue
		}
		payload, source = root, candidate.source
		break
	}
	if payload == nil {
		return QuotaReport{}, fmt.Errorf("Kimi quota requests failed: %s", strings.Join(errorsByEndpoint, "; "))
	}

	windows := make([]QuotaWindow, 0, 6)
	if usage, _ := payload["usage"].(map[string]any); usage != nil {
		metadata := quotaMap(usage["window"])
		kind := quotaDurationKind(metadata)
		if kind == "" {
			kind = "7d"
		}
		if window, ok := kimiQuotaWindow(kind, firstQuotaText(scalarQuotaText(usage["name"]), scalarQuotaText(usage["title"]), scalarQuotaText(usage["label"]), "7 天"), usage, metadata, now); ok {
			windows = append(windows, window)
		}
	}
	if rows, _ := payload["limits"].([]any); rows != nil {
		for index, raw := range rows {
			row, _ := raw.(map[string]any)
			if row == nil {
				continue
			}
			detail := quotaMap(row["detail"])
			if detail == nil {
				detail = row
			}
			metadata := quotaMap(row["window"])
			label := firstQuotaText(
				scalarQuotaText(row["name"]), scalarQuotaText(row["title"]), scalarQuotaText(row["scope"]),
				scalarQuotaText(detail["name"]), scalarQuotaText(detail["title"]), quotaDurationLabel(metadata), fmt.Sprintf("频控窗口 %d", index+1),
			)
			kind := quotaDurationKind(metadata)
			if kind == "" {
				kind = quotaSlug(label)
			}
			if window, ok := kimiQuotaWindow(kind, label, detail, metadata, now); ok {
				windows = append(windows, window)
			}
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("Kimi quota response contains no usable windows")
	}
	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  quotaPlanType(payload, document),
		Supported: true,
		Source:    source,
		Observed:  now,
		Windows:   windows,
	}, nil
}

func kimiQuotaWindow(kind, label string, detail, metadata map[string]any, now time.Time) (QuotaWindow, bool) {
	limit := numericQuota(firstQuotaValue(detail["limit"], detail["total"], detail["quota"]))
	usedRaw := numericQuota(firstQuotaValue(detail["used"], detail["consumed"]))
	remaining := numericQuota(firstQuotaValue(detail["remaining"], detail["left"]))
	used := percentQuota(firstQuotaValue(detail["used_percent"], detail["usedPercent"], detail["utilization"]))
	if used == nil {
		used = quotaPercentFromAmounts(usedRaw, remaining, limit)
	}
	if used == nil && remaining == nil && limit == nil {
		return QuotaWindow{}, false
	}
	return QuotaWindow{
		Kind: kind, Label: label, UsedPercent: used, RemainingPercent: quotaComplement(used),
		ResetsAt: quotaResetTime(detail, metadata, now), Enforceable: true, Unit: quotaUnit(detail, "units"),
		Limit: limit, Remaining: quotaRemainingAmount(usedRaw, remaining, limit),
	}, true
}

func quotaPayloadRoot(payload map[string]any) map[string]any {
	if root, _ := payload["data"].(map[string]any); root != nil {
		return root
	}
	return payload
}

func quotaMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func quotaPercentFromAmounts(used, remaining, limit *float64) *float64 {
	if limit == nil || *limit <= 0 {
		return nil
	}
	if used != nil {
		value := clampQuota(*used / *limit * 100)
		return &value
	}
	if remaining != nil {
		value := clampQuota(100 - *remaining / *limit * 100)
		return &value
	}
	return nil
}

func quotaRemainingAmount(used, remaining, limit *float64) *float64 {
	if remaining != nil {
		return remaining
	}
	if used == nil || limit == nil {
		return nil
	}
	value := max(0, *limit-*used)
	return &value
}

func quotaResetTime(detail, metadata map[string]any, now time.Time) *time.Time {
	for _, source := range []map[string]any{detail, metadata} {
		if source == nil {
			continue
		}
		for _, key := range []string{"resets_at", "reset_at", "resetAt", "reset_time", "resetTime", "next_reset_at"} {
			if parsed := parseQuotaTime(source[key], now); parsed != nil {
				return parsed
			}
		}
		for _, key := range []string{"reset_in", "resetIn", "reset_in_seconds", "ttl", "remaining_seconds"} {
			if seconds := numericQuota(source[key]); seconds != nil && *seconds >= 0 {
				parsed := now.Add(time.Duration(*seconds * float64(time.Second))).UTC()
				return &parsed
			}
		}
	}
	return nil
}

func quotaDurationSeconds(metadata map[string]any) int64 {
	if metadata == nil {
		return 0
	}
	duration := numericQuota(metadata["duration"])
	if duration == nil || *duration <= 0 {
		return 0
	}
	unit := strings.ToLower(firstQuotaText(scalarQuotaText(metadata["timeUnit"]), scalarQuotaText(metadata["time_unit"]), scalarQuotaText(metadata["unit"])))
	multiplier := float64(1)
	switch {
	case strings.Contains(unit, "minute"):
		multiplier = 60
	case strings.Contains(unit, "hour"):
		multiplier = 60 * 60
	case strings.Contains(unit, "day"):
		multiplier = 24 * 60 * 60
	}
	return int64(*duration * multiplier)
}

func quotaDurationKind(metadata map[string]any) string {
	seconds := quotaDurationSeconds(metadata)
	if seconds == 18_000 {
		return "5h"
	}
	if seconds == 604_800 {
		return "7d"
	}
	if seconds > 0 && seconds%86_400 == 0 {
		return fmt.Sprintf("%dd", seconds/86_400)
	}
	if seconds > 0 && seconds%3_600 == 0 {
		return fmt.Sprintf("%dh", seconds/3_600)
	}
	if seconds > 0 && seconds%60 == 0 {
		return fmt.Sprintf("%dm", seconds/60)
	}
	return ""
}

func quotaDurationLabel(metadata map[string]any) string {
	return quotaDurationKind(metadata)
}

func quotaUnit(value map[string]any, fallback string) string {
	return firstQuotaText(scalarQuotaText(value["unit"]), scalarQuotaText(value["quota_unit"]), fallback)
}

func quotaPlanType(root, document map[string]any) string {
	plan := firstQuotaText(
		scalarQuotaText(root["plan"]), scalarQuotaText(root["plan_name"]), scalarQuotaText(root["subscription_plan"]),
		scalarQuotaText(root["tier"]), scalarQuotaText(root["membership"]), scalarQuotaText(root["level"]), scalarQuotaText(root["product"]),
	)
	if plan == "" {
		if subscription := quotaMap(root["subscription"]); subscription != nil {
			plan = firstQuotaText(scalarQuotaText(subscription["name"]), scalarQuotaText(subscription["plan"]), scalarQuotaText(subscription["tier"]), scalarQuotaText(subscription["level"]))
		}
	}
	return firstQuotaText(plan, scalarQuotaText(document["plan_type"]), scalarQuotaText(document["subscription_type"]))
}
