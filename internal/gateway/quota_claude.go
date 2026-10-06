package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// OAuth subscription usage is separate from Anthropic API-key billing.
// utilization is already a percentage; sub-1 values must not be scaled.
func probeClaudeQuota(ctx context.Context, client *http.Client, endpoint, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	report := QuotaReport{AuthIndex: authIndex, Provider: provider, Source: "claude-oauth-usage", Observed: now, Windows: []QuotaWindow{}}
	token := firstQuotaText(scalarQuotaText(document["access_token"]), scalarQuotaText(document["accessToken"]))
	if token == "" {
		if firstQuotaText(scalarQuotaText(document["api_key"]), scalarQuotaText(document["apiKey"])) != "" {
			return report, nil
		}
		return report, errors.New("Claude quota credential is missing access_token; re-authorize the subscription account")
	}
	if strings.TrimSpace(endpoint) == "" {
		return report, errors.New("Claude quota endpoint is not configured")
	}
	payload, err := requestQuotaJSON(ctx, client, endpoint, http.Header{
		"Accept":         {"application/json"},
		"Authorization":  {"Bearer " + token},
		"Anthropic-Beta": {"oauth-2025-04-20"},
	})
	if err != nil {
		return report, fmt.Errorf("Claude quota request: %w", err)
	}
	for field, raw := range payload {
		kind, label, enforceable := "", "", false
		switch {
		case field == "five_hour":
			kind, label, enforceable = quotaKind5h, quotaKindLabel(quotaKind5h), true
		case field == "seven_day":
			kind, label, enforceable = quotaKind7d, quotaKindLabel(quotaKind7d), true
		case strings.HasPrefix(field, "seven_day_"):
			scope := strings.TrimPrefix(field, "seven_day_")
			kind, label = "7d-"+quotaSlug(scope), strings.ReplaceAll(scope, "_", " ")+" 7 天"
		case field == "extra_usage":
			if enabled, _ := quotaMap(raw)["is_enabled"].(bool); !enabled {
				continue
			}
			kind, label = "extra-usage", "额外用量"
		default:
			continue
		}
		row := quotaMap(raw)
		used := percentQuota(row["utilization"])
		if used == nil {
			continue
		}
		reset := parseQuotaTime(row["resets_at"], now)
		// Only account-wide windows with a future reset can constrain admission.
		// Model-scoped and extra usage windows remain observations.
		enforceable = enforceable && reset != nil && reset.After(now)
		report.Windows = append(report.Windows, QuotaWindow{Kind: kind, Label: label, UsedPercent: used, RemainingPercent: quotaComplement(used), ResetsAt: reset, Enforceable: enforceable})
	}
	report.Windows = validQuotaWindows(report.Windows, now)
	if len(report.Windows) == 0 {
		return report, errors.New("Claude quota response contains no usable windows")
	}
	report.Supported = true
	report.PlanType = firstQuotaText(scalarQuotaText(payload["plan_type"]), scalarQuotaText(document["subscription_type"]), scalarQuotaText(document["plan_type"]))
	return report, nil
}
