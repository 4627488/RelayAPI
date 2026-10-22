package gateway

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

func probeClaudeAccount(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	// Explicit inference-only setup tokens cannot read subscription usage. Older
	// CPA documents without scopes still get probed; absence is not denial.
	if claudeMissingProfileScope(document) && claudeQuotaToken(document) != "" {
		return QuotaReport{AuthIndex: authIndex, Provider: provider, Observed: now, Source: "claude-oauth-usage", Windows: []QuotaWindow{}, Subscription: &QuotaSubscription{Status: "unsupported", Source: "credential", ErrorCode: "missing_profile_scope"}}, nil
	}
	report, err := probeClaudeQuota(ctx, client, endpoints.claudeUsage, authIndex, provider, document, now)
	if claudeQuotaToken(document) == "" || endpoints.claudeProfile == "" {
		return report, err
	}
	// Profile is advisory: a slow or forbidden profile lookup must not discard
	// usable quota observations or trigger a refresh of an already working token.
	profileCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	usageErr := err
	profile, err := requestQuotaJSON(profileCtx, client, endpoints.claudeProfile, claudeQuotaHeaders(claudeQuotaToken(document)))
	report.Subscription = &QuotaSubscription{Status: "error", Source: "credential"}
	if err != nil {
		code := "request_failed"
		var upstream *QuotaHTTPError
		if errors.As(err, &upstream) {
			switch upstream.StatusCode {
			case http.StatusUnauthorized:
				code = "unauthorized"
			case http.StatusForbidden:
				code = "forbidden"
			case http.StatusTooManyRequests:
				code = "rate_limited"
			}
		}
		// Persist only a bounded code; profile error bodies can contain identities.
		report.Subscription.ErrorCode = code
		return report, usageErr
	}
	plan := claudeProfilePlan(profile)
	organization := quotaMap(profile["organization"])
	if plan == "" && len(organization) == 0 {
		report.Subscription.ErrorCode = "invalid_response"
		return report, usageErr
	}
	// A successful profile supersedes stale credential hints, including a tier
	// change to an unknown product. Never infer a subscription from usage alone.
	report.PlanType = plan
	report.Subscription = &QuotaSubscription{
		Status: "supported", Source: "claude-oauth-profile",
		RateLimitTier:      scalarQuotaText(organization["rate_limit_tier"]),
		SubscriptionStatus: scalarQuotaText(organization["subscription_status"]),
		BillingType:        scalarQuotaText(organization["billing_type"]),
	}
	if enabled, ok := organization["has_extra_usage_enabled"].(bool); ok {
		report.Subscription.ExtraUsageEnabled = &enabled
	}
	return report, usageErr
}

func claudeProfilePlan(profile map[string]any) string {
	org := quotaMap(profile["organization"])
	// The token's organization wins over personal account flags on Team tokens.
	if plan := claudePlan(scalarQuotaText(org["organization_type"])); plan != "" {
		return plan
	}
	if plan := claudePlan(scalarQuotaText(org["rate_limit_tier"])); plan != "" {
		return plan
	}
	account := quotaMap(profile["account"])
	if account["has_claude_max"] == true {
		return "max"
	}
	if account["has_claude_pro"] == true {
		return "pro"
	}
	if account["has_claude_max"] == false && account["has_claude_pro"] == false {
		return "free"
	}
	return ""
}

func claudePlan(raw string) string {
	value := strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(strings.TrimSpace(raw)), "default_"), "claude_")
	switch value {
	case "free", "pro", "max", "team", "enterprise":
		return value
	case "max_5x", "max_20x":
		return "max"
	}
	return ""
}

func claudeMissingProfileScope(document map[string]any) bool {
	raw := firstQuotaValue(document["scopes"], document["scope"])
	var scopes []string
	switch value := raw.(type) {
	case string:
		scopes = strings.Fields(value)
	case []any:
		for _, scope := range value {
			if text, ok := scope.(string); ok {
				scopes = append(scopes, text)
			}
		}
	case []string:
		scopes = value
	default:
		return false
	}
	if len(scopes) == 0 {
		return false
	}
	for _, scope := range scopes {
		if scope == "user:profile" {
			return false
		}
	}
	return true
}

func claudeQuotaToken(document map[string]any) string {
	return firstQuotaText(scalarQuotaText(document["access_token"]), scalarQuotaText(document["accessToken"]))
}

func claudeQuotaHeaders(token string) http.Header {
	return http.Header{"Accept": {"application/json"}, "Authorization": {"Bearer " + token}, "Anthropic-Beta": {"oauth-2025-04-20"}}
}

// OAuth subscription usage is separate from Anthropic API-key billing.
// utilization is already a percentage; sub-1 values must not be scaled.
func probeClaudeQuota(ctx context.Context, client *http.Client, endpoint, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	report := QuotaReport{AuthIndex: authIndex, Provider: provider, Source: "claude-oauth-usage", Observed: now, Windows: []QuotaWindow{}}
	report.PlanType = claudePlan(firstQuotaText(scalarQuotaText(document["subscription_type"]), scalarQuotaText(document["subscriptionType"]), scalarQuotaText(document["plan_type"]), scalarQuotaText(document["rate_limit_tier"]), scalarQuotaText(document["rateLimitTier"])))
	token := claudeQuotaToken(document)
	if token == "" {
		if firstQuotaText(scalarQuotaText(document["api_key"]), scalarQuotaText(document["apiKey"])) != "" {
			return report, nil
		}
		return report, errors.New("Claude quota credential is missing access_token; re-authorize the subscription account")
	}
	if strings.TrimSpace(endpoint) == "" {
		return report, errors.New("Claude quota endpoint is not configured")
	}
	payload, err := requestQuotaJSON(ctx, client, endpoint, claudeQuotaHeaders(token))
	if err != nil {
		return report, fmt.Errorf("Claude quota request: %w", err)
	}
	for field, raw := range payload {
		row := quotaMap(raw)
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
			if window, ok := claudeExtraUsage(row); ok {
				report.Windows = append(report.Windows, window)
			}
			continue
		default:
			// Independent dollar pools have their own schema and units. They must not
			// be mistaken for subscription percentages or extra-usage cents.
			if window, ok := claudeDollarWindow(field, row, now); ok {
				report.Windows = append(report.Windows, window)
			}
			continue
		}
		used := percentQuota(row["utilization"])
		if used == nil {
			continue
		}
		reset := parseQuotaTime(row["resets_at"], now)
		enforceable = enforceable && reset != nil && reset.After(now)
		report.Windows = append(report.Windows, QuotaWindow{Kind: kind, Label: label, UsedPercent: used, RemainingPercent: quotaComplement(used), ResetsAt: reset, Enforceable: enforceable})
	}
	// New model-scoped rows are observations only, including unrecognized models.
	// A percentage alone cannot establish an account-wide capacity generation.
	rows, _ := payload["limits"].([]any)
	// Prefer explicitly active rows when an older/inactive representation of
	// the same model is also present; validQuotaWindows keeps the first kind.
	sort.SliceStable(rows, func(i, j int) bool {
		return quotaMap(rows[i])["is_active"] == true && quotaMap(rows[j])["is_active"] != true
	})
	for _, raw := range rows {
		row := quotaMap(raw)
		if active, ok := row["is_active"].(bool); ok && !active {
			continue
		}
		if scalarQuotaText(row["kind"]) != "weekly_scoped" {
			continue
		}
		model := quotaMap(lookupQuotaPath(row, "scope.model"))
		id := quotaSlug(firstQuotaText(scalarQuotaText(model["id"]), scalarQuotaText(model["display_name"])))
		used := percentQuota(row["percent"])
		if id == "" || used == nil {
			continue
		}
		report.Windows = append(report.Windows, QuotaWindow{Kind: "7d-model-" + id, Label: firstQuotaText(scalarQuotaText(model["display_name"]), id) + " 7 天", UsedPercent: used, RemainingPercent: quotaComplement(used), ResetsAt: parseQuotaTime(row["resets_at"], now)})
	}
	report.Windows = validQuotaWindows(report.Windows, now)
	if len(report.Windows) == 0 {
		return report, errors.New("Claude quota response contains no usable windows")
	}
	report.Supported = true
	return report, nil
}

func claudeExtraUsage(row map[string]any) (QuotaWindow, bool) {
	window := QuotaWindow{Kind: "extra-usage", Label: "额外用量", UsedPercent: percentQuota(row["utilization"])}
	if enabled, ok := row["is_enabled"].(bool); ok {
		window.Enabled = &enabled
	}
	window.Limit, window.Used = claudeAmount(row["monthly_limit"], 100), claudeAmount(row["used_credits"], 100)
	currency := strings.ToUpper(scalarQuotaText(row["currency"]))
	if currency == "" {
		currency = "USD"
	}
	window.Unit = currency
	completeClaudeAmounts(&window)
	return window, len(row) > 0 && (window.Enabled != nil || window.UsedPercent != nil || window.Limit != nil || window.Used != nil)
}

func claudeDollarWindow(field string, row map[string]any, now time.Time) (QuotaWindow, bool) {
	window := QuotaWindow{Kind: "credits-" + quotaSlug(field), Label: strings.ReplaceAll(field, "_", " "), Unit: "USD", UsedPercent: percentQuota(row["utilization"]), ResetsAt: parseQuotaTime(row["resets_at"], now), Limit: claudeAmount(row["limit_dollars"], 1), Used: claudeAmount(row["used_dollars"], 1), Remaining: claudeAmount(row["remaining_dollars"], 1)}
	if window.Limit == nil && window.Used == nil && window.Remaining == nil {
		return QuotaWindow{}, false
	}
	completeClaudeAmounts(&window)
	return window, true
}

func claudeAmount(raw any, divisor float64) *float64 {
	amount := numericQuota(raw)
	if amount == nil || *amount < 0 {
		return nil
	}
	value := *amount / divisor
	return &value
}

func completeClaudeAmounts(window *QuotaWindow) {
	if window.Remaining == nil && window.Limit != nil && window.Used != nil {
		remaining := math.Max(0, *window.Limit-*window.Used)
		window.Remaining = &remaining
	}
	if window.UsedPercent == nil && window.Limit != nil && *window.Limit > 0 && window.Used != nil {
		used := clampQuota(*window.Used / *window.Limit * 100)
		window.UsedPercent = &used
	}
	window.RemainingPercent = quotaComplement(window.UsedPercent)
}
