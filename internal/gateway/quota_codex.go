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
	codexQuotaUserAgent  = "codex_cli_rs/0.144.1 (Linux x86_64) xterm-256color"
	codexQuotaBeta       = "codex-1"
	codexQuotaOriginator = "Codex Desktop"
	codexQuotaLanguage   = "zh-CN"
	codexSparkFeature    = "codex_bengalfox"
)

func probeCodexQuota(ctx context.Context, client *http.Client, endpoint, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(document["access_token"])
	if token == "" {
		return QuotaReport{}, errors.New("codex quota credential is missing access_token")
	}
	accountID := firstQuotaText(
		scalarQuotaText(document["account_id"]),
		scalarQuotaText(document["chatgpt_account_id"]),
		scalarQuotaText(document["organization_id"]),
	)
	if accountID == "" {
		return QuotaReport{}, errors.New("chatgpt account id is missing; re-authorize the Codex account")
	}
	if strings.TrimSpace(endpoint) == "" {
		return QuotaReport{}, errors.New("codex quota endpoint is not configured")
	}

	payload, err := requestQuotaJSON(ctx, client, endpoint, codexQuotaHeaders(token, accountID))
	if err != nil {
		return QuotaReport{}, fmt.Errorf("codex quota request: %w", err)
	}

	windows := make([]QuotaWindow, 0, 4)
	rateLimit := quotaMap(firstQuotaValue(payload["rate_limit"], payload["rate_limits"]))
	windows = appendCodexWindow(windows, quotaMap(firstQuotaValue(rateLimit["five_hour"], rateLimit["primary_window"], rateLimit["primary"])), quotaKind5h, true, now)
	windows = appendCodexWindow(windows, quotaMap(firstQuotaValue(rateLimit["weekly"], rateLimit["secondary_window"], rateLimit["secondary"])), quotaKind7d, true, now)
	if rows, _ := payload["additional_rate_limits"].([]any); rows != nil {
		for _, raw := range rows {
			row := quotaMap(raw)
			if !strings.EqualFold(scalarQuotaText(row["metered_feature"]), codexSparkFeature) {
				continue
			}
			extra := quotaMap(firstQuotaValue(row["rate_limit"], row["rate_limits"]))
			windows = appendCodexWindow(windows, quotaMap(firstQuotaValue(extra["five_hour"], extra["primary_window"], extra["primary"])), quotaKindSpark5h, false, now)
			windows = appendCodexWindow(windows, quotaMap(firstQuotaValue(extra["weekly"], extra["secondary_window"], extra["secondary"])), quotaKindSpark7d, false, now)
		}
	}
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("codex quota response contains no usable windows")
	}

	return QuotaReport{
		AuthIndex: authIndex,
		Provider:  provider,
		PlanType:  firstQuotaText(scalarQuotaText(payload["plan_type"]), scalarQuotaText(payload["plan"])),
		Supported: true,
		Source:    "codex-wham",
		Observed:  now,
		Windows:   validQuotaWindows(windows, now),
	}, nil
}

func codexQuotaHeaders(token, accountID string) http.Header {
	return http.Header{
		"Accept":             {"application/json"},
		"Authorization":      {"Bearer " + token},
		"User-Agent":         {codexQuotaUserAgent},
		"ChatGPT-Account-ID": {accountID},
		"OpenAI-Beta":        {codexQuotaBeta},
		"Originator":         {codexQuotaOriginator},
		"OAI-Language":       {codexQuotaLanguage},
		"Sec-Fetch-Site":     {"none"},
		"Sec-Fetch-Mode":     {"no-cors"},
		"Sec-Fetch-Dest":     {"empty"},
		"Priority":           {"u=4, i"},
	}
}

func appendCodexWindow(windows []QuotaWindow, value map[string]any, fallbackKind string, enforceable bool, now time.Time) []QuotaWindow {
	if value == nil {
		return windows
	}
	used := percentQuota(value["used_percent"])
	if used == nil {
		if left := percentQuota(value["percent_left"]); left != nil {
			remaining := 100 - *left
			used = &remaining
		}
	}
	if used == nil {
		return windows
	}
	kind := fallbackKind
	if seconds := numericQuota(value["limit_window_seconds"]); seconds != nil {
		if mapped := kindFromLimitSeconds(int64(*seconds)); mapped != "" {
			if strings.HasPrefix(fallbackKind, "spark-") {
				kind = "spark-" + mapped
			} else {
				kind = mapped
			}
		} else {
			switch fallbackKind {
			case quotaKind5h:
				kind = "codex-primary"
			case quotaKind7d:
				kind = "codex-secondary"
			case quotaKindSpark5h:
				kind = "spark-primary"
			case quotaKindSpark7d:
				kind = "spark-secondary"
			}
		}
	}
	resetsAt := quotaResetTime(value, nil, now)
	if resetsAt == nil {
		if resetMillis := numericQuota(value["reset_time_ms"]); resetMillis != nil && *resetMillis > 0 {
			reset := time.UnixMilli(int64(*resetMillis)).UTC()
			resetsAt = &reset
		}
	}
	return append(windows, QuotaWindow{
		Kind:             kind,
		Label:            quotaKindLabel(kind),
		UsedPercent:      used,
		RemainingPercent: quotaComplement(used),
		ResetsAt:         resetsAt,
		Enforceable:      enforceable && isStandardQuotaKind(kind),
	})
}
