package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	kimiQuotaUserAgent   = "KimiCLI/1.3"
	kimiQuotaPlatform    = "kimi_cli"
	kimiQuotaVersion     = "1.3"
	kimiQuotaDeviceName  = "RelayAPI"
	kimiQuotaDeviceModel = "Linux 6.8.0 x86_64"
	kimiQuotaOSVersion   = "6.8.0"
	kimiFiveHourMinutes  = 5 * 60
	kimiSevenDayMinutes  = 7 * 24 * 60
)

func probeKimiQuota(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(firstQuotaValue(document["access_token"], document["accessToken"], document["api_key"], document["apiKey"]))
	if token == "" {
		return QuotaReport{}, errors.New("Kimi quota credential is missing access_token")
	}
	headers := kimiQuotaHeaders(firstQuotaText(scalarQuotaText(document["device_id"]), authIndex), token)

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

	windows := make([]QuotaWindow, 0, 2)
	if usage := quotaMap(payload["usage"]); usage != nil {
		if window, ok := amountWindow(quotaKind7d, quotaKindLabel(quotaKind7d), usage, quotaMap(usage["window"]), true, now); ok {
			windows = append(windows, window)
		}
	}

	var fiveHour, firstLimit map[string]any
	var firstLimitMeta map[string]any
	if rows, _ := payload["limits"].([]any); rows != nil {
		for _, raw := range rows {
			row := quotaMap(raw)
			if row == nil {
				continue
			}
			detail := quotaMap(row["detail"])
			if detail == nil {
				detail = row
			}
			metadata := quotaMap(row["window"])
			if firstLimit == nil {
				firstLimit, firstLimitMeta = detail, metadata
			}
			switch quotaDurationMinutes(metadata) {
			case kimiFiveHourMinutes:
				if fiveHour == nil {
					fiveHour = detail
					if window, ok := amountWindow(quotaKind5h, quotaKindLabel(quotaKind5h), detail, metadata, true, now); ok {
						windows = append(windows, window)
					}
				}
			case kimiSevenDayMinutes:
				if !hasQuotaKind(windows, quotaKind7d) {
					if window, ok := amountWindow(quotaKind7d, quotaKindLabel(quotaKind7d), detail, metadata, true, now); ok {
						windows = append(windows, window)
					}
				}
			}
		}
	}
	if !hasQuotaKind(windows, quotaKind5h) && firstLimit != nil && fiveHour == nil {
		if window, ok := amountWindow(quotaKind5h, quotaKindLabel(quotaKind5h), firstLimit, firstLimitMeta, true, now); ok {
			windows = append(windows, window)
		}
	}

	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("Kimi quota response contains no usable windows")
	}
	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  kimiMembershipPlan(payload, document),
		Supported: true,
		Source:    source,
		Observed:  now,
		Windows:   windows,
	}, nil
}

func kimiQuotaHeaders(deviceID, token string) http.Header {
	return http.Header{
		"Accept":             {"application/json"},
		"Authorization":      {"Bearer " + token},
		"User-Agent":         {kimiQuotaUserAgent},
		"X-Msh-Platform":     {kimiQuotaPlatform},
		"X-Msh-Version":      {kimiQuotaVersion},
		"X-Msh-Device-Name":  {kimiQuotaDeviceName},
		"X-Msh-Device-Model": {kimiQuotaDeviceModel},
		"X-Msh-Os-Version":   {kimiQuotaOSVersion},
		"X-Msh-Device-Id":    {strings.TrimSpace(deviceID)},
	}
}

func kimiMembershipPlan(payload, document map[string]any) string {
	user := quotaMap(payload["user"])
	membership := quotaMap(user["membership"])
	level := strings.TrimSpace(scalarQuotaText(membership["level"]))
	if level != "" {
		return strings.TrimPrefix(strings.ToUpper(level), "LEVEL_")
	}
	return firstQuotaText(
		scalarQuotaText(payload["plan"]),
		scalarQuotaText(payload["plan_type"]),
		scalarQuotaText(payload["tier"]),
		scalarQuotaText(document["plan_type"]),
	)
}

func hasQuotaKind(windows []QuotaWindow, kind string) bool {
	for _, window := range windows {
		if window.Kind == kind {
			return true
		}
	}
	return false
}
