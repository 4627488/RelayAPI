package app

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/tidwall/gjson"
)

// These are the provider wire fields, not app-server's camelCase account API.
// Codex consumes headers for HTTP and codex.rate_limits events for WebSockets.
type codexQuotaWindow struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetAt       int64   `json:"reset_at"`
}

type codexQuotaLimits struct {
	Primary   *codexQuotaWindow `json:"primary"`
	Secondary *codexQuotaWindow `json:"secondary"`
}

type codexQuotaEvent struct {
	Type      string           `json:"type"`
	LimitID   string           `json:"metered_limit_name"`
	LimitName string           `json:"limit_name"`
	Limits    codexQuotaLimits `json:"rate_limits"`
}

func emptyCodexQuota() codexQuotaEvent {
	return codexQuotaEvent{Type: "codex.rate_limits", LimitID: "codex", LimitName: "RelayAPI"}
}

func (q codexQuotaEvent) setHeaders(header http.Header) {
	for _, entry := range []struct {
		name   string
		window *codexQuotaWindow
	}{{"primary", q.Limits.Primary}, {"secondary", q.Limits.Secondary}} {
		if entry.window == nil {
			continue
		}
		prefix := "X-" + strings.ReplaceAll(q.LimitID, "_", "-") + "-" + entry.name
		header.Set(prefix+"-Used-Percent", strconv.FormatFloat(entry.window.UsedPercent, 'f', -1, 64))
		header.Set(prefix+"-Window-Minutes", strconv.Itoa(entry.window.WindowMinutes))
		header.Set(prefix+"-Reset-At", strconv.FormatInt(entry.window.ResetAt, 10))
	}
	if q.Limits.Primary != nil || q.Limits.Secondary != nil {
		header.Set("X-"+strings.ReplaceAll(q.LimitID, "_", "-")+"-Limit-Name", q.LimitName)
	}
}

// Duration-bearing kinds are authoritative; a reset timestamp is only a countdown.
func codexWindowMinutes(kind string) int {
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "daily":
		kind = "1d"
	case "weekly":
		kind = "7d"
	}
	if strings.HasSuffix(kind, "d") || strings.HasSuffix(kind, "w") {
		multiplier := int64(1440)
		if strings.HasSuffix(kind, "w") {
			multiplier *= 7
		}
		n, err := strconv.ParseInt(kind[:len(kind)-1], 10, 64)
		if err != nil || n <= 0 || n > 2147483647/multiplier {
			return 0
		}
		return int(n * multiplier)
	}
	d, err := time.ParseDuration(kind)
	if err != nil || d <= 0 || d%time.Minute != 0 || d/time.Minute > 2147483647 {
		return 0
	}
	return int(d / time.Minute)
}

type codexQuotaEvents []codexQuotaEvent

func (events codexQuotaEvents) setHeaders(header http.Header) {
	for _, event := range events {
		event.setHeaders(header)
	}
}

// IDs exclude mutable names, so a rename cannot leave a second cached quota.
// One bucket per window avoids Codex's two-window ceiling and slot reassignment.
func projectCodexSubscriptionQuotas(subscriptions []store.SubscriptionQuota, now time.Time) codexQuotaEvents {
	events := make(codexQuotaEvents, 0)
	for _, subscription := range subscriptions {
		provider := strings.Map(func(r rune) rune {
			if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
				return r
			}
			return '-'
		}, strings.ToLower(subscription.Provider))
		provider = strings.Trim(provider, "-")
		if provider == "" {
			provider = "subscription"
		}
		if len(provider) > 32 {
			provider = provider[:32]
		}
		for _, w := range subscription.Windows {
			minutes := codexWindowMinutes(w.Kind)
			if minutes == 0 || w.LimitNanoUSD < 0 || w.SettledNanoUSD < 0 || w.ReservedNanoUSD < 0 || !w.ResetsAt.After(now) {
				continue
			}
			digest := sha256.Sum256([]byte(subscription.ChildID + "\x00" + w.Kind))
			id := fmt.Sprintf("rai_%s_%x", strings.ReplaceAll(provider, "-", "_"), digest[:12])
			name := subscription.Name
			// HTTP field values must remain ASCII for Codex's HeaderValue::to_str.
			if name == "" || strings.IndexFunc(name, func(r rune) bool { return r < 32 || r > 126 }) >= 0 {
				name = provider
			}
			used := 100.0
			if w.LimitNanoUSD > 0 {
				used = math.Min(100, (float64(w.SettledNanoUSD)+float64(w.ReservedNanoUSD))/float64(w.LimitNanoUSD)*100)
			}
			events = append(events, codexQuotaEvent{Type: "codex.rate_limits", LimitID: id, LimitName: name,
				Limits: codexQuotaLimits{Primary: &codexQuotaWindow{UsedPercent: used, WindowMinutes: minutes, ResetAt: w.ResetsAt.Unix()}}})
		}
	}
	return events
}

// Current Codex clients retain one group per response. Keep its ID constant so
// switching subscriptions replaces both slots, including an absent second window.
// For more than two windows, show the two shortest valid periods deterministically.
func projectSelectedCodexQuota(subscriptions []store.SubscriptionQuota, childID string, now time.Time) codexQuotaEvent {
	result := emptyCodexQuota()
	if childID == "" {
		return result
	}
	for _, subscription := range subscriptions {
		if subscription.ChildID != childID {
			continue
		}
		windows := projectCodexSubscriptionQuotas([]store.SubscriptionQuota{subscription}, now)
		sort.Slice(windows, func(i, j int) bool {
			left, right := windows[i].Limits.Primary, windows[j].Limits.Primary
			if left.WindowMinutes != right.WindowMinutes {
				return left.WindowMinutes < right.WindowMinutes
			}
			return windows[i].LimitID < windows[j].LimitID
		})
		if len(windows) > 0 {
			result.LimitName = windows[0].LimitName
			result.Limits.Primary = windows[0].Limits.Primary
		}
		if len(windows) > 1 {
			result.Limits.Secondary = windows[1].Limits.Primary
		}
		return result
	}
	return result
}

func (a *App) requestCodexQuota(ctx context.Context, key store.KeyContext, admission store.Admission) codexQuotaEvent {
	if admission.ChildSubscriptionID == "" || a.store.DB == nil {
		return emptyCodexQuota()
	}
	ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	var models []string
	if a.nativeRuntime != nil {
		models = a.nativeRuntime.Models()
	}
	subscriptions, err := a.store.SubscriptionQuotas(ctx, key, models, time.Now())
	// Do not leave another subscription's allowance visible after a routing change.
	// An empty snapshot means unavailable, never exhausted or unlimited.
	if err != nil {
		return emptyCodexQuota()
	}
	return projectSelectedCodexQuota(subscriptions, admission.ChildSubscriptionID, time.Now())
}

func isCodexQuotaEvent(payload []byte) bool {
	return gjson.GetBytes(payload, "type").String() == "codex.rate_limits"
}

func wantsCodexQuotaEvents(r *http.Request) bool {
	switch identifyClientUserAgent(r.UserAgent()).Name {
	case "Codex CLI", "Codex Desktop", "Codex VS Code":
		return true
	default:
		return false
	}
}
