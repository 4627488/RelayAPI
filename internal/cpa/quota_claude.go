package cpa

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func probeClaudeQuota(ctx context.Context, client *http.Client, endpoint, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(firstQuotaValue(document["access_token"], document["accessToken"]))
	if token == "" {
		return QuotaReport{}, errors.New("Claude quota credential is missing access_token")
	}
	headers := http.Header{
		"Accept":         {"application/json"},
		"Authorization":  {"Bearer " + token},
		"Anthropic-Beta": {"oauth-2025-04-20"},
		"Content-Type":   {"application/json"},
		"User-Agent":     {"RelayAPI/claude-quota"},
	}
	payload, err := requestQuotaJSON(ctx, client, endpoint, headers)
	if err != nil {
		return QuotaReport{}, fmt.Errorf("Claude quota request: %w", err)
	}
	root := quotaPayloadRoot(payload)
	windows := make([]QuotaWindow, 0, 8)
	definitions := []struct {
		key         string
		kind        string
		label       string
		enforceable bool
	}{
		{key: "five_hour", kind: "5h", label: "5 小时", enforceable: true},
		{key: "seven_day", kind: "7d", label: "7 天", enforceable: true},
		{key: "seven_day_oauth_apps", kind: "oauth-apps-7d", label: "OAuth 应用 7 天", enforceable: false},
		{key: "seven_day_opus", kind: "opus-7d", label: "Opus 7 天", enforceable: false},
		{key: "seven_day_sonnet", kind: "sonnet-7d", label: "Sonnet 7 天", enforceable: false},
		{key: "seven_day_cowork", kind: "cowork-7d", label: "Cowork 7 天", enforceable: false},
	}
	for _, definition := range definitions {
		value, _ := root[definition.key].(map[string]any)
		if window, ok := claudeQuotaWindow(definition.kind, definition.label, value, definition.enforceable, now); ok {
			windows = append(windows, window)
		}
	}
	if extra, _ := root["iguana_necktie"].(map[string]any); quotaBool(extra["is_enabled"]) {
		if window, ok := claudeExtraQuotaWindow(extra, now); ok {
			windows = append(windows, window)
		}
	} else if extra, _ := root["extra_usage"].(map[string]any); quotaBool(extra["is_enabled"]) || len(extra) > 0 {
		if window, ok := claudeExtraQuotaWindow(extra, now); ok {
			windows = append(windows, window)
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("Claude quota response contains no usable windows")
	}
	plan := firstQuotaText(
		scalarQuotaText(root["rate_limit_tier"]),
		scalarQuotaText(root["plan"]),
		scalarQuotaText(document["plan_type"]),
		scalarQuotaText(document["subscription_type"]),
	)
	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  plan,
		Supported: true,
		Source:    "claude-oauth-usage",
		Observed:  now,
		Windows:   windows,
	}, nil
}

func claudeQuotaWindow(kind, label string, value map[string]any, enforceable bool, now time.Time) (QuotaWindow, bool) {
	if value == nil {
		return QuotaWindow{}, false
	}
	used := percentQuota(firstQuotaValue(value["utilization"], value["used_percent"], value["usedPercent"]))
	limit := numericQuota(firstQuotaValue(value["limit"], value["total"]))
	usedRaw := numericQuota(firstQuotaValue(value["used"], value["consumed"]))
	remaining := numericQuota(firstQuotaValue(value["remaining"], value["left"]))
	if used == nil {
		used = quotaPercentFromAmounts(usedRaw, remaining, limit)
	}
	if used == nil && remaining == nil && limit == nil {
		return QuotaWindow{}, false
	}
	return QuotaWindow{
		Kind:             kind,
		Label:            label,
		UsedPercent:      used,
		RemainingPercent: quotaComplement(used),
		ResetsAt:         quotaResetTime(value, nil, now),
		Enforceable:      enforceable,
		Unit:             quotaUnit(value, "units"),
		Limit:            limit,
		Remaining:        quotaRemainingAmount(usedRaw, remaining, limit),
	}, true
}

func claudeExtraQuotaWindow(value map[string]any, now time.Time) (QuotaWindow, bool) {
	limit := numericQuota(firstQuotaValue(value["monthly_limit"], value["limit"], value["total"]))
	usedRaw := numericQuota(firstQuotaValue(value["used_credits"], value["spend"], value["used"], value["consumed"]))
	remaining := numericQuota(firstQuotaValue(value["remaining_credits"], value["remaining"], value["left"]))
	used := percentQuota(firstQuotaValue(value["utilization"], value["used_percent"], value["usedPercent"]))
	if used == nil {
		used = quotaPercentFromAmounts(usedRaw, remaining, limit)
	}
	if used == nil && remaining == nil && limit == nil {
		return QuotaWindow{}, false
	}
	return QuotaWindow{
		Kind: "extra-credits", Label: "额外用量", UsedPercent: used, RemainingPercent: quotaComplement(used),
		ResetsAt: quotaResetTime(value, nil, now), Enforceable: false, Unit: quotaUnit(value, "credits"),
		Limit: limit, Remaining: quotaRemainingAmount(usedRaw, remaining, limit),
	}, true
}

func quotaBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}
