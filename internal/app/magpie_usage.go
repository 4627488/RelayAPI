package app

import (
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

// Magpie recognizes sub2api by the /v1/usage path, without a provider preset.
// Its windows apply to the entire key, not to individual models or grants.
type magpieUsageDocument struct {
	magpieBalanceDocument
	IsValid      bool              `json:"isValid"`
	Mode         string            `json:"mode"`
	Status       string            `json:"status"`
	PlanName     string            `json:"planName"`
	Unit         string            `json:"unit"`
	Balance      *float64          `json:"balance,omitempty"`
	Remaining    *float64          `json:"remaining,omitempty"`
	RateLimits   []magpieRateLimit `json:"rate_limits"`
	QuotaMapping string            `json:"quota_mapping"`
}

type magpieRateLimit struct {
	Window    string    `json:"window"`
	Limit     float64   `json:"limit"`
	Used      float64   `json:"used"`
	Remaining float64   `json:"remaining"`
	ResetAt   time.Time `json:"reset_at"`
}

func magpieBilling(key store.KeyContext, quotas []store.SubscriptionQuota, models []string) string {
	covered := map[string]bool{}
	hasPlan, hasCash := false, false
	for _, q := range quotas {
		if q.BalanceBilled {
			hasCash = true
			continue
		}
		hasPlan = true
		for _, model := range q.Models {
			covered[strings.ToLower(model)] = true
		}
	}
	for _, model := range models {
		if key.AllowsModel(model) && !covered[strings.ToLower(model)] {
			hasCash = true
		}
	}
	switch {
	case hasPlan && !hasCash:
		return "plan"
	case !hasPlan:
		return "payg"
	default:
		return "auto"
	}
}

func projectMagpieUsage(key store.KeyContext, quotas []store.SubscriptionQuota, models []string, now time.Time) magpieUsageDocument {
	doc := magpieUsageDocument{magpieBalanceDocument: projectMagpieBalance(key, quotas, now),
		IsValid: true, Mode: "quota_limited", Status: "active", PlanName: "RelayAPI", Unit: "USD",
		RateLimits: []magpieRateLimit{}}
	if magpieBilling(key, quotas, models) == "payg" {
		doc.Mode, doc.QuotaMapping = "unrestricted", "cash"
		doc.Balance, doc.Remaining = &doc.BalanceUSD, &doc.BalanceUSD
		return doc
	}
	windows, reason := magpieNativeWindows(key, quotas, models, now)
	doc.QuotaMapping = reason
	if windows != nil {
		doc.RateLimits = windows
		doc.PlanName = quotas[0].Name
	}
	// A plan has no total dollar balance: its independent window allowances
	// cannot be added to one another or to the wallet. Older clients retain
	// the full subscription summary through the explicit balance_path.
	return doc
}

func magpieNativeWindows(key store.KeyContext, quotas []store.SubscriptionQuota, models []string, now time.Time) ([]magpieRateLimit, string) {
	if len(quotas) != 1 {
		return nil, "multiple_subscriptions"
	}
	q := quotas[0]
	if q.BalanceBilled {
		return nil, "model_scoped"
	}
	covered := map[string]bool{}
	for _, model := range q.Models {
		covered[strings.ToLower(model)] = true
	}
	visible := 0
	for _, model := range models {
		if key.AllowsModel(model) {
			visible++
			if !covered[strings.ToLower(model)] {
				return nil, "model_scoped"
			}
		}
	}
	if visible == 0 {
		return nil, "no_models"
	}
	if q.Unavailable || (q.ExpiresAt != nil && !q.ExpiresAt.After(now)) {
		return nil, "unavailable"
	}
	if len(q.Windows) == 0 {
		return nil, "unknown"
	}
	byKind := map[string]store.ChildQuotaWindow{}
	for _, w := range q.Windows {
		switch w.Kind {
		case "5h", "1d", "7d":
		default:
			return nil, "unsupported_window"
		}
		if _, duplicate := byKind[w.Kind]; duplicate {
			return nil, "unsupported_window"
		}
		// Magpie drops nonpositive limits and treats a missing reset as a
		// fresh window. Neither behavior represents unknown or zero quotas.
		if w.LimitNanoUSD < 0 {
			return nil, "unknown"
		}
		if w.LimitNanoUSD == 0 {
			return nil, "zero_limit"
		}
		if !w.ResetsAt.After(now) {
			return nil, "awaiting_refresh"
		}
		if q.ExpiresAt != nil && !q.ExpiresAt.After(w.ResetsAt) {
			return nil, "expires_before_reset"
		}
		byKind[w.Kind] = w
	}
	out := make([]magpieRateLimit, 0, len(byKind))
	for _, kind := range []string{"5h", "1d", "7d"} {
		w, ok := byKind[kind]
		if !ok {
			continue
		}
		// Convert separately to avoid an int64 overflow when adding spend
		// and in-flight reservations. Keep overspend rather than clipping it.
		used := float64(max(int64(0), w.SettledNanoUSD))/1e9 + float64(max(int64(0), w.ReservedNanoUSD))/1e9
		limit := float64(w.LimitNanoUSD) / 1e9
		out = append(out, magpieRateLimit{Window: kind, Limit: limit, Used: used, Remaining: max(0, limit-used),
			ResetAt: w.ResetsAt.UTC()})
	}
	return out, "native"
}
