package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
)

const maxQuotaResponseBytes = 2 << 20

type QuotaProbeCredential struct {
	AuthIndex string
	Provider  string
	Document  json.RawMessage
	ProxyURL  string
}

type QuotaReport struct {
	AuthIndex string        `json:"auth_index"`
	Provider  string        `json:"provider"`
	PlanType  string        `json:"plan_type"`
	Supported bool          `json:"supported"`
	Source    string        `json:"source"`
	Observed  time.Time     `json:"observed_at"`
	Windows   []QuotaWindow `json:"windows"`
}

type QuotaWindow struct {
	Kind             string     `json:"kind"`
	Label            string     `json:"label"`
	UsedPercent      *float64   `json:"used_percent"`
	RemainingPercent *float64   `json:"remaining_percent"`
	ResetsAt         *time.Time `json:"resets_at"`
	Enforceable      bool       `json:"enforceable"`
	Unit             string     `json:"unit"`
	Limit            *float64   `json:"limit"`
	Remaining        *float64   `json:"remaining"`
}

type quotaEndpoints struct {
	codexUsage        string
	kimiUsage         string
	kimiUsageFallback string
	xaiCredits        string
	xaiBilling        string
}

var productionQuotaEndpoints = quotaEndpoints{
	codexUsage:        "https://chatgpt.com/backend-api/wham/usage",
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
	if report, ok := documentQuotaReport(document, provider, credential.AuthIndex, now); ok {
		return report, nil
	}
	client, err := egress.OutboundHTTPClient(credential.ProxyURL, 25*time.Second)
	if err != nil {
		return QuotaReport{}, err
	}
	return probeQuotaWithClient(ctx, client, productionQuotaEndpoints, credential.AuthIndex, provider, document, now)
}

func probeQuotaWithClient(ctx context.Context, client *http.Client, endpoints quotaEndpoints, authIndex, provider string, document map[string]any, now time.Time) (QuotaReport, error) {
	switch provider {
	case "codex", "codex-oauth", "chatgpt":
		return probeCodexQuota(ctx, client, endpoints.codexUsage, authIndex, provider, document, now)
	case "kimi", "kimi-code", "moonshot":
		return probeKimiQuota(ctx, client, endpoints, authIndex, provider, document, now)
	case "xai", "x-ai", "grok":
		return probeXAIQuota(ctx, client, endpoints, authIndex, provider, document, now)
	default:
		return QuotaReport{AuthIndex: authIndex, Provider: provider, Supported: false, Observed: now, Windows: []QuotaWindow{}}, nil
	}
}

func documentQuotaReport(document map[string]any, provider, authIndex string, now time.Time) (QuotaReport, bool) {
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
			windows = append(windows, QuotaWindow{Kind: kind, Label: firstQuotaText(scalarQuotaText(item["label"]), quotaKindLabel(kind)), UsedPercent: used, RemainingPercent: remaining, ResetsAt: parseQuotaTime(firstQuotaValue(item["resets_at"], item["resetsAt"]), now), Enforceable: enforceable, Unit: scalarQuotaText(item["unit"]), Limit: numericQuota(item["limit"]), Remaining: numericQuota(item["remaining"])})
		}
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return QuotaReport{}, false
	}
	return QuotaReport{AuthIndex: authIndex, Provider: provider, PlanType: scalarQuotaText(root["plan_type"]), Supported: true, Source: "credential-extension", Observed: now, Windows: windows}, true
}

func validQuotaWindows(items []QuotaWindow, now time.Time) []QuotaWindow {
	result := make([]QuotaWindow, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		item.Kind = quotaSlug(item.Kind)
		if item.Kind == "" {
			continue
		}
		if item.Label == "" {
			item.Label = quotaKindLabel(item.Kind)
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
