package gateway

import (
	"strings"
	"time"
)

const (
	quotaKind5h      = "5h"
	quotaKind1d      = "1d"
	quotaKind7d      = "7d"
	quotaKindMonthly = "monthly"
	quotaKindPrepaid = "prepaid"
	quotaKindSpark5h = "spark-5h"
	quotaKindSpark7d = "spark-7d"

	seconds5h = 5 * 60 * 60
	seconds1d = 24 * 60 * 60
	seconds7d = 7 * 24 * 60 * 60
)

func kindFromLimitSeconds(seconds int64) string {
	switch seconds {
	case seconds5h:
		return quotaKind5h
	case seconds1d:
		return quotaKind1d
	case seconds7d:
		return quotaKind7d
	default:
		return ""
	}
}

func isStandardQuotaKind(kind string) bool {
	switch strings.TrimSpace(kind) {
	case quotaKind5h, quotaKind1d, quotaKind7d:
		return true
	default:
		return false
	}
}

func quotaKindLabel(kind string) string {
	switch quotaSlug(kind) {
	case quotaKind5h:
		return "5 小时"
	case quotaKind1d:
		return "1 天"
	case quotaKind7d:
		return "7 天"
	case quotaKindMonthly:
		return "月度"
	case quotaKindPrepaid:
		return "预付余额"
	case quotaKindSpark5h:
		return "Spark 5 小时"
	case quotaKindSpark7d:
		return "Spark 7 天"
	default:
		return kind
	}
}

func quotaPayloadRoot(payload map[string]any) map[string]any {
	if root := quotaMap(payload["data"]); root != nil {
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
		for _, key := range []string{"resets_at", "reset_at", "resetAt", "resetTime", "reset_time", "next_reset_at"} {
			if parsed := parseQuotaTime(source[key], now); parsed != nil {
				return parsed
			}
		}
		for _, key := range []string{"reset_in", "resetIn", "reset_in_seconds", "reset_after_seconds", "ttl", "remaining_seconds"} {
			if seconds := numericQuota(source[key]); seconds != nil && *seconds >= 0 {
				parsed := now.Add(time.Duration(*seconds * float64(time.Second))).UTC()
				return &parsed
			}
		}
	}
	return nil
}

func quotaDurationMinutes(metadata map[string]any) int64 {
	if metadata == nil {
		return 0
	}
	duration := numericQuota(firstQuotaValue(metadata["duration"], metadata["value"]))
	if duration == nil || *duration <= 0 {
		return 0
	}
	unit := strings.ToUpper(firstQuotaText(scalarQuotaText(metadata["timeUnit"]), scalarQuotaText(metadata["time_unit"]), scalarQuotaText(metadata["unit"])))
	switch {
	case strings.Contains(unit, "MINUTE"):
		return int64(*duration)
	case strings.Contains(unit, "HOUR"):
		return int64(*duration) * 60
	case strings.Contains(unit, "DAY"):
		return int64(*duration) * 24 * 60
	case strings.Contains(unit, "SECOND"):
		return int64(*duration) / 60
	default:
		return 0
	}
}

func quotaUnit(value map[string]any, fallback string) string {
	if value == nil {
		return fallback
	}
	return firstQuotaText(scalarQuotaText(value["unit"]), scalarQuotaText(value["quota_unit"]), fallback)
}

func amountWindow(kind, label string, detail, metadata map[string]any, enforceable bool, now time.Time) (QuotaWindow, bool) {
	if detail == nil {
		return QuotaWindow{}, false
	}
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
		Kind: kind, Label: firstQuotaText(label, quotaKindLabel(kind)), UsedPercent: used, RemainingPercent: quotaComplement(used),
		ResetsAt: quotaResetTime(detail, metadata, now), Enforceable: enforceable && isStandardQuotaKind(kind),
		Unit: quotaUnit(detail, "units"), Limit: limit, Remaining: quotaRemainingAmount(usedRaw, remaining, limit),
	}, true
}
