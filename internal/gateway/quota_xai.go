package gateway

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

const (
	xaiQuotaClientVersion = "0.2.120"
	xaiQuotaTokenAuth     = "xai-grok-cli"
)

func probeXAIQuota(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(firstQuotaValue(document["access_token"], document["accessToken"]))
	if token == "" {
		return QuotaReport{}, errors.New("xAI quota credential is missing access_token")
	}
	headers := xaiQuotaHeaders(document, token)

	creditsStatus, credits, creditsErr := requestQuotaHTTP(ctx, client, endpoints.xaiCredits, headers)
	billingStatus, billing, billingErr := requestQuotaHTTP(ctx, client, endpoints.xaiBilling, headers)
	creditsUnavailable := xaiBillingUnavailable(creditsStatus, creditsErr)
	billingUnavailable := xaiBillingUnavailable(billingStatus, billingErr)

	if creditsErr != nil && !creditsUnavailable && billingErr != nil && !billingUnavailable {
		return QuotaReport{}, fmt.Errorf("xAI quota requests failed: credits: %v; billing: %v", creditsErr, billingErr)
	}
	if creditsUnavailable && billingUnavailable {
		return QuotaReport{AuthIndex: authIndex, Provider: provider, Supported: false, Source: "xai-billing", Observed: now, Windows: []QuotaWindow{}}, nil
	}
	if creditsErr != nil && !creditsUnavailable && (billingErr != nil || billing == nil) {
		return QuotaReport{}, fmt.Errorf("xAI quota request: %w", creditsErr)
	}
	if billingErr != nil && !billingUnavailable && credits == nil {
		return QuotaReport{}, fmt.Errorf("xAI quota request: %w", billingErr)
	}
	settingsPlan := ""
	if endpoints.xaiSettings != "" {
		settingsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		settings, settingsErr := requestQuotaJSON(settingsCtx, client, endpoints.xaiSettings, headers)
		cancel()
		if settingsErr == nil {
			settingsPlan = xaiSettingsPlan(quotaPayloadRoot(settings))
		}
	}

	windows := make([]QuotaWindow, 0, 3)
	plan := ""
	if credits != nil {
		credits = quotaPayloadRoot(credits)
		plan = xaiSubscriptionPlan(credits)
		if window, ok := xaiIncludedWindow(credits, now); ok {
			windows = append(windows, window)
		}
		if window, ok := xaiPrepaidWindow(credits); ok {
			windows = append(windows, window)
		}
	}
	if billing != nil {
		billing = quotaPayloadRoot(billing)
		if plan == "" {
			plan = xaiSubscriptionPlan(billing)
		}
		if window, ok := xaiMonthlyWindow(billing, now); ok {
			windows = append(windows, window)
		}
		if !hasQuotaKind(windows, quotaKindPrepaid) {
			if window, ok := xaiPrepaidWindow(billing); ok {
				windows = append(windows, window)
			}
		}
	}
	if settingsPlan != "" {
		plan = settingsPlan
	}

	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  plan,
		Supported: true,
		Source:    "xai-billing",
		Observed:  now,
		Windows:   validQuotaWindows(windows, now),
	}, nil
}

func xaiQuotaHeaders(document map[string]any, token string) http.Header {
	headers := http.Header{
		"Accept":                {"application/json"},
		"Authorization":         {"Bearer " + token},
		"X-XAI-Token-Auth":      {xaiQuotaTokenAuth},
		"X-Grok-Client-Version": {xaiQuotaClientVersion},
		"X-Grok-Client-Mode":    {"cli"},
		"User-Agent":            {"grok-pager/" + xaiQuotaClientVersion + " grok-shell/" + xaiQuotaClientVersion},
	}
	if userID := xaiQuotaUserID(document); userID != "" {
		headers.Set("x-userid", userID)
	}
	return headers
}

func xaiQuotaUserID(document map[string]any) string {
	paths := []string{
		"sub", "subject", "user_id", "userId",
		"metadata.sub", "metadata.subject", "metadata.user_id", "metadata.userId",
		"attributes.sub", "attributes.subject", "attributes.user_id", "attributes.userId",
		"oauth.sub", "oauth.subject", "metadata.oauth.sub", "metadata.oauth.subject", "attributes.oauth.sub", "attributes.oauth.subject",
		"user.sub", "user.id", "metadata.user.sub", "metadata.user.id", "attributes.user.sub", "attributes.user.id",
	}
	for _, path := range paths {
		if value := scalarQuotaText(lookupQuotaPath(document, path)); value != "" {
			return value
		}
	}
	return ""
}

func xaiBillingUnavailable(status int, err error) bool {
	if status == http.StatusPreconditionFailed {
		return true
	}
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no personal team") ||
		(strings.Contains(message, "personal team") && strings.Contains(message, "not found"))
}

func xaiIncludedWindow(credits map[string]any, now time.Time) (QuotaWindow, bool) {
	config := quotaMap(credits["config"])
	if config == nil {
		return QuotaWindow{}, false
	}
	period := quotaMap(firstQuotaValue(config["currentPeriod"], config["current_period"]))
	periodType := strings.ToUpper(firstQuotaText(scalarQuotaText(period["type"]), scalarQuotaText(period["periodType"]), scalarQuotaText(period["period_type"])))
	kind := "included"
	switch {
	case strings.Contains(periodType, "WEEKLY"):
		kind = quotaKind7d
	case strings.Contains(periodType, "MONTHLY"):
		kind = quotaKindMonthly
	}
	resetsAt := parseQuotaTime(firstQuotaValue(period["end"], period["ends_at"], config["billingPeriodEnd"], config["billing_period_end"]), now)
	used := percentQuota(firstQuotaValue(config["creditUsagePercent"], config["credit_usage_percent"]))
	if used == nil && resetsAt == nil {
		return QuotaWindow{}, false
	}
	if used == nil {
		zero := 0.0
		used = &zero
	}
	label := quotaKindLabel(kind)
	if kind == "included" {
		label = "订阅额度（周期未知）"
	}
	return QuotaWindow{
		Kind:             kind,
		Label:            label,
		UsedPercent:      used,
		RemainingPercent: quotaComplement(used),
		ResetsAt:         resetsAt,
		Enforceable:      kind == quotaKind7d,
	}, true
}

func xaiMonthlyWindow(billing map[string]any, now time.Time) (QuotaWindow, bool) {
	config := quotaMap(billing["config"])
	if config == nil {
		return QuotaWindow{}, false
	}
	usedValue := xaiQuotaCentValue(config["used"])
	limitValue := xaiQuotaCentValue(firstQuotaValue(config["monthlyLimit"], config["monthly_limit"]))
	if usedValue == nil || limitValue == nil || *limitValue <= 0 {
		return QuotaWindow{}, false
	}
	includedUsed := math.Min(*usedValue, *limitValue)
	used := clampQuota(includedUsed / *limitValue * 100)
	return QuotaWindow{
		Kind:             quotaKindMonthly,
		Label:            quotaKindLabel(quotaKindMonthly),
		UsedPercent:      &used,
		RemainingPercent: quotaComplement(&used),
		ResetsAt:         parseQuotaTime(firstQuotaValue(config["billingPeriodEnd"], config["billing_period_end"]), now),
		Enforceable:      false,
	}, true
}

func xaiPrepaidWindow(payload map[string]any) (QuotaWindow, bool) {
	config := quotaMap(payload["config"])
	prepaid := xaiQuotaCentValue(firstQuotaValue(config["prepaidBalance"], config["prepaid_balance"]))
	if prepaid == nil || *prepaid <= 0 {
		return QuotaWindow{}, false
	}
	remaining := math.Abs(*prepaid) / 100
	return QuotaWindow{Kind: quotaKindPrepaid, Label: quotaKindLabel(quotaKindPrepaid), Enforceable: false, Unit: "USD", Remaining: &remaining}, true
}

func xaiSubscriptionPlan(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	config := quotaMap(payload["config"])
	return firstQuotaText(
		scalarQuotaText(payload["subscriptionTier"]),
		scalarQuotaText(payload["subscription_tier"]),
		scalarQuotaText(config["subscriptionTier"]),
		scalarQuotaText(config["subscription_tier"]),
	)
}

func xaiSettingsPlan(payload map[string]any) string {
	return firstQuotaText(
		scalarQuotaText(payload["subscription_tier_display"]),
		scalarQuotaText(payload["subscriptionTierDisplay"]),
		scalarQuotaText(payload["subscription_tier"]),
		scalarQuotaText(payload["subscriptionTier"]),
	)
}

func xaiQuotaCentValue(value any) *float64 {
	if object := quotaMap(value); object != nil {
		return numericQuota(object["val"])
	}
	return numericQuota(value)
}
