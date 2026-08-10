package cpa

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

const maxQuotaResponseBytes = 2 << 20

type QuotaProbeCredential struct {
	AuthIndex string
	Provider  string
	Document  json.RawMessage
	ProxyURL  string
}

type quotaEndpoints struct {
	codexUsage        string
	claudeUsage       string
	antigravityLoad   string
	antigravityModels []string
	kimiUsage         string
	kimiUsageFallback string
	xaiCredits        string
	xaiBilling        string
}

var productionQuotaEndpoints = quotaEndpoints{
	codexUsage:      "https://chatgpt.com/backend-api/wham/usage",
	claudeUsage:     "https://api.anthropic.com/api/oauth/usage",
	antigravityLoad: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
	antigravityModels: []string{
		"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
		"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	},
	kimiUsage:         "https://api.kimi.com/coding/v1/usages",
	kimiUsageFallback: "https://api.moonshot.ai/v1/usages",
	xaiCredits:        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	xaiBilling:        "https://cli-chat-proxy.grok.com/v1/billing",
}

func ProbeQuota(ctx context.Context, credential QuotaProbeCredential) (QuotaReport, error) {
	if strings.TrimSpace(credential.AuthIndex) == "" {
		return QuotaReport{}, errors.New("auth index is required")
	}
	var document map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(credential.Document)))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return QuotaReport{}, fmt.Errorf("decode native credential: %w", err)
	}
	now := time.Now().UTC()
	provider := normalizeQuotaProvider(firstQuotaText(credential.Provider, scalarQuotaText(document["provider"]), scalarQuotaText(document["type"])))
	if report, ok := embeddedQuotaReport(document, provider, credential.AuthIndex, now); ok {
		return report, nil
	}
	proxyURL := strings.TrimSpace(credential.ProxyURL)
	if override := scalarQuotaText(document["_relay_proxy_url"]); override != "" {
		proxyURL = override
	}
	client, err := quotaHTTPClient(proxyURL, 25*time.Second)
	if err != nil {
		return QuotaReport{}, err
	}
	return probeQuotaWithClient(ctx, client, productionQuotaEndpoints, credential.AuthIndex, provider, document, now)
}

func probeQuotaWithClient(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	switch provider {
	case "codex", "codex-oauth", "chatgpt":
		return probeCodexQuota(ctx, client, endpoints.codexUsage, authIndex, provider, document, now)
	case "anthropic", "claude", "claude-code", "claude-oauth":
		return probeClaudeQuota(ctx, client, endpoints.claudeUsage, authIndex, provider, document, now)
	case "antigravity", "google-antigravity":
		return probeAntigravityQuota(ctx, client, endpoints, authIndex, provider, document, now)
	case "kimi", "kimi-code", "moonshot":
		return probeKimiQuota(ctx, client, endpoints, authIndex, provider, document, now)
	case "xai", "x-ai", "grok":
		return probeXAIQuota(ctx, client, endpoints, authIndex, provider, document, now)
	default:
		return QuotaReport{AuthIndex: authIndex, Provider: provider, Supported: false, Observed: now, Windows: []QuotaWindow{}}, nil
	}
}

func probeCodexQuota(ctx context.Context, client *http.Client, endpoint, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	headers := http.Header{
		"Accept":        {"application/json"},
		"Authorization": {"Bearer " + scalarQuotaText(document["access_token"])},
		"User-Agent":    {"codex_cli_rs/0.98.0"},
	}
	if accountID := scalarQuotaText(document["account_id"]); accountID != "" {
		headers.Set("Chatgpt-Account-Id", accountID)
	}
	if strings.TrimSpace(strings.TrimPrefix(headers.Get("Authorization"), "Bearer ")) == "" {
		return QuotaReport{}, errors.New("codex quota credential is missing access_token")
	}
	payload, err := requestQuotaJSON(ctx, client, endpoint, headers)
	if err != nil {
		return QuotaReport{}, fmt.Errorf("codex quota request: %w", err)
	}
	windows := make([]QuotaWindow, 0, 6)
	rateLimit, _ := lookupQuotaPath(payload, "rate_limit").(map[string]any)
	for _, name := range []string{"primary_window", "secondary_window"} {
		window, _ := rateLimit[name].(map[string]any)
		if mapped, ok := codexQuotaWindow(name, window, now); ok {
			windows = append(windows, mapped)
		}
	}
	if rows, _ := lookupQuotaPath(payload, "additional_rate_limits").([]any); rows != nil {
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			limitName := scalarQuotaText(row["limit_name"])
			for _, name := range []string{"primary_window", "secondary_window"} {
				window, _ := lookupQuotaPath(row, "rate_limit."+name).(map[string]any)
				mapped, ok := codexQuotaWindow(name, window, now)
				if !ok {
					continue
				}
				mapped.Kind = quotaSlug(limitName + "-" + strings.TrimSuffix(name, "_window"))
				mapped.Label = firstQuotaText(limitName, mapped.Kind)
				mapped.Enforceable = false
				windows = append(windows, mapped)
			}
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("codex quota response contains no usable windows")
	}
	return QuotaReport{
		AuthIndex: authIndex, Provider: provider, PlanType: scalarQuotaText(payload["plan_type"]),
		Supported: true, Source: "codex-wham", Observed: now, Windows: windows,
	}, nil
}

func codexQuotaWindow(name string, value map[string]any, now time.Time) (QuotaWindow, bool) {
	if value == nil {
		return QuotaWindow{}, false
	}
	seconds := int64(0)
	if number := numericQuota(value["limit_window_seconds"]); number != nil {
		seconds = int64(*number)
	}
	kind := map[int64]string{18_000: "5h", 604_800: "7d"}[seconds]
	if kind == "" {
		kind = quotaSlug(strings.TrimSuffix(name, "_window"))
	}
	used := percentQuota(value["used_percent"])
	if used == nil {
		return QuotaWindow{}, false
	}
	return QuotaWindow{
		Kind: kind, Label: kind, UsedPercent: used, RemainingPercent: quotaComplement(used),
		ResetsAt: parseQuotaTime(value["reset_at"], now), Enforceable: true,
	}, true
}

func probeXAIQuota(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	token := scalarQuotaText(document["access_token"])
	if token == "" {
		return QuotaReport{}, errors.New("xAI quota credential is missing access_token")
	}
	headers := http.Header{
		"Accept":                {"application/json"},
		"Authorization":         {"Bearer " + token},
		"Content-Type":          {"application/json"},
		"X-XAI-Token-Auth":      {"xai-grok-cli"},
		"X-Grok-Client-Version": {"0.2.93"},
		"User-Agent":            {"grok-pager/0.2.93 grok-shell/0.2.93"},
	}
	credits, creditsErr := requestQuotaJSON(ctx, client, endpoints.xaiCredits, headers)
	billing, billingErr := requestQuotaJSON(ctx, client, endpoints.xaiBilling, headers)
	if creditsErr != nil && billingErr != nil {
		return QuotaReport{}, fmt.Errorf("xAI quota requests failed: credits: %v; billing: %v", creditsErr, billingErr)
	}
	windows := make([]QuotaWindow, 0, 8)
	if creditsErr == nil {
		used := percentQuota(lookupQuotaPath(credits, "config.creditUsagePercent"))
		if used != nil {
			windows = append(windows, QuotaWindow{Kind: "7d", Label: "7 天", UsedPercent: used, RemainingPercent: quotaComplement(used), ResetsAt: parseQuotaTime(lookupQuotaPath(credits, "config.currentPeriod.end"), now), Enforceable: true})
		}
		if rows, _ := lookupQuotaPath(credits, "config.productUsage").([]any); rows != nil {
			for _, raw := range rows {
				row, _ := raw.(map[string]any)
				used := percentQuota(row["usagePercent"])
				kind := quotaSlug(scalarQuotaText(row["product"]) + "-usage")
				if kind != "" && used != nil {
					windows = append(windows, QuotaWindow{Kind: kind, Label: scalarQuotaText(row["product"]), UsedPercent: used, RemainingPercent: quotaComplement(used), ResetsAt: parseQuotaTime(lookupQuotaPath(credits, "config.currentPeriod.end"), now), Enforceable: false})
				}
			}
		}
	}
	plan := ""
	if billingErr == nil {
		usedValue := numericQuota(lookupQuotaPath(billing, "config.used.val"))
		limitValue := numericQuota(lookupQuotaPath(billing, "config.monthlyLimit.val"))
		if usedValue != nil && limitValue != nil && *limitValue > 0 {
			used := clampQuota(*usedValue / *limitValue * 100)
			windows = append(windows, QuotaWindow{Kind: "monthly", Label: "月度", UsedPercent: &used, RemainingPercent: quotaComplement(&used), ResetsAt: parseQuotaTime(lookupQuotaPath(billing, "config.billingPeriodEnd"), now), Enforceable: true})
		}
		if limitValue != nil {
			plan = map[int64]string{0: "free", 15_000: "supergrok", 150_000: "supergrok-heavy"}[int64(*limitValue)]
			if plan == "" {
				plan = strconv.FormatFloat(*limitValue, 'f', -1, 64)
			}
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, errors.New("xAI quota responses contain no usable windows")
	}
	return QuotaReport{AuthIndex: authIndex, Provider: provider, PlanType: plan, Supported: true, Source: "xai-billing", Observed: now, Windows: windows}, nil
}

func requestQuotaJSON(ctx context.Context, client *http.Client, endpoint string, headers http.Header) (map[string]any, error) {
	return requestQuotaJSONBody(ctx, client, http.MethodGet, endpoint, headers, nil)
}

func requestQuotaJSONBody(ctx context.Context, client *http.Client, method, endpoint string, headers http.Header, body any) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode upstream request JSON: %w", err)
		}
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	request.Header = headers.Clone()
	if body != nil && request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return nil, fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxQuotaResponseBytes))
	decoder.UseNumber()
	var payload map[string]any
	if err = decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode upstream JSON: %w", err)
	}
	return payload, nil
}

func embeddedQuotaReport(document map[string]any, provider, authIndex string, now time.Time) (QuotaReport, bool) {
	root, _ := firstQuotaValue(document["relay_quota"], document["relayQuota"]).(map[string]any)
	if root == nil {
		return QuotaReport{}, false
	}
	rows, _ := root["windows"].([]any)
	windows := make([]QuotaWindow, 0, len(rows))
	for _, raw := range rows {
		item, _ := raw.(map[string]any)
		kind := quotaSlug(firstQuotaText(scalarQuotaText(item["kind"]), scalarQuotaText(item["id"])))
		used := percentQuota(firstQuotaValue(item["used_percent"], item["usedPercent"]))
		remaining := percentQuota(firstQuotaValue(item["remaining_percent"], item["remainingPercent"]))
		if used == nil && remaining != nil {
			value := clampQuota(100 - *remaining)
			used = &value
		}
		if remaining == nil {
			remaining = quotaComplement(used)
		}
		enforceable, _ := item["enforceable"].(bool)
		if kind != "" && (used != nil || remaining != nil) {
			windows = append(windows, QuotaWindow{Kind: kind, Label: firstQuotaText(scalarQuotaText(item["label"]), kind), UsedPercent: used, RemainingPercent: remaining, ResetsAt: parseQuotaTime(firstQuotaValue(item["resets_at"], item["resetsAt"]), now), Enforceable: enforceable, Unit: scalarQuotaText(item["unit"]), Limit: numericQuota(item["limit"]), Remaining: numericQuota(item["remaining"])})
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, false
	}
	return QuotaReport{AuthIndex: authIndex, Provider: provider, PlanType: scalarQuotaText(root["plan_type"]), Supported: true, Source: "credential-extension", Observed: now, Windows: windows}, true
}

func quotaHTTPClient(rawProxy string, timeout time.Duration) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	value := strings.TrimSpace(rawProxy)
	if value == "" {
		return &http.Client{Transport: transport, Timeout: timeout}, nil
	}
	if strings.EqualFold(value, "direct") || strings.EqualFold(value, "none") {
		transport.Proxy = nil
		return &http.Client{Transport: transport, Timeout: timeout}, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return nil, errors.New("invalid native quota proxy URL")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		transport.Proxy = http.ProxyURL(parsed)
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if parsed.User != nil {
			password, _ := parsed.User.Password()
			auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
		}
		dialer, dialErr := proxy.SOCKS5("tcp", parsed.Host, auth, proxy.Direct)
		if dialErr != nil {
			return nil, fmt.Errorf("create native quota SOCKS5 dialer: %w", dialErr)
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if contextDialer, ok := dialer.(proxy.ContextDialer); ok {
				return contextDialer.DialContext(ctx, network, address)
			}
			return dialer.Dial(network, address)
		}
	default:
		return nil, fmt.Errorf("unsupported native quota proxy scheme %q", parsed.Scheme)
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

func NativeOutboundHTTPClient(rawProxy string, timeout time.Duration) (*http.Client, error) {
	return quotaHTTPClient(rawProxy, timeout)
}

func validQuotaWindows(items []QuotaWindow, now time.Time) []QuotaWindow {
	result := make([]QuotaWindow, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		item.Kind = quotaSlug(item.Kind)
		if item.Kind == "" {
			continue
		}
		if item.ResetsAt != nil && !item.ResetsAt.After(now) {
			item.ResetsAt = nil
		}
		if _, exists := seen[item.Kind]; exists {
			continue
		}
		seen[item.Kind] = struct{}{}
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Kind < result[j].Kind })
	return result
}

func lookupQuotaPath(value any, path string) any {
	current := value
	for _, segment := range strings.Split(strings.Trim(path, "."), ".") {
		switch typed := current.(type) {
		case map[string]any:
			current = typed[segment]
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(typed) {
				return nil
			}
			current = typed[index]
		default:
			return nil
		}
		if current == nil {
			return nil
		}
	}
	return current
}

func parseQuotaTime(value any, now time.Time) *time.Time {
	if number := numericQuota(value); number != nil && *number > 0 {
		seconds := *number
		if seconds > 1e12 {
			seconds /= 1000
		}
		parsed := time.Unix(int64(seconds), 0).UTC()
		return &parsed
	}
	text := scalarQuotaText(value)
	if text == "" {
		return nil
	}
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		parsed = parsed.UTC()
		return &parsed
	}
	if duration, err := time.ParseDuration(text); err == nil {
		parsed := now.Add(duration).UTC()
		return &parsed
	}
	return nil
}

func scalarQuotaText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int:
		return strconv.Itoa(typed)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}

func numericQuota(value any) *float64 {
	var result float64
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil
		}
		result = parsed
	case float64:
		result = typed
	case int:
		result = float64(typed)
	case int64:
		result = float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return nil
		}
		result = parsed
	default:
		return nil
	}
	if math.IsNaN(result) || math.IsInf(result, 0) {
		return nil
	}
	return &result
}

func percentQuota(value any) *float64 {
	result := numericQuota(value)
	if result == nil {
		return nil
	}
	clamped := clampQuota(*result)
	return &clamped
}

func quotaComplement(used *float64) *float64 {
	if used == nil {
		return nil
	}
	remaining := clampQuota(100 - *used)
	return &remaining
}

func clampQuota(value float64) float64 { return math.Max(0, math.Min(100, value)) }

func firstQuotaText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstQuotaValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func normalizeQuotaProvider(value string) string {
	return quotaSlug(value)
}

func quotaSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastDash := false
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			builder.WriteRune(char)
			lastDash = false
		} else if builder.Len() > 0 && !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(builder.String(), "-")
}
