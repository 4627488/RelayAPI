package app

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/4627488/RelayAPI/internal/store"
)

// Magpie accepts at most 200 bytes here. Read a live string rather than binding
// the imported provider to today's grant IDs, names, or number of quota windows.
const magpieBalancePath = "可用现金: $ balance_usd; 订阅: subscription_summary"

type magpieQuotaWindow struct {
	Remaining   *float64  `json:"remaining"`
	ResetsAt    time.Time `json:"resets_at"`
	State       string    `json:"state"`
	LimitUSD    *float64  `json:"limit_usd,omitempty"`
	SettledUSD  float64   `json:"settled_usd"`
	ReservedUSD float64   `json:"reserved_usd"`
}

type magpieSubscription struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Models    []string   `json:"models"`
	State     string     `json:"state"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type magpieBalanceDocument struct {
	// TenantBalance already excludes cash reserved by in-flight requests.
	BalanceUSD          float64 `json:"balance_usd"`
	SubscriptionSummary string  `json:"subscription_summary"`
	// Keep old object paths readable for providers imported before the stable path.
	Subscriptions map[string]map[string]magpieQuotaWindow `json:"subscriptions"`
	Grants        []magpieSubscription                    `json:"grants"`
}

func magpieQuotaID(value string) string {
	var result strings.Builder
	result.WriteByte('q')
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			result.WriteRune(c)
		} else {
			result.WriteByte('_')
		}
	}
	return result.String()
}

func projectMagpieBalance(key store.KeyContext, quotas []store.SubscriptionQuota, now time.Time) magpieBalanceDocument {
	document := magpieBalanceDocument{BalanceUSD: float64(key.TenantBalance) / 1e9,
		Subscriptions: map[string]map[string]magpieQuotaWindow{}, Grants: []magpieSubscription{}}
	summaries := make([]string, 0, len(quotas))
	for _, quota := range quotas {
		windows := map[string]magpieQuotaWindow{}
		grant := magpieSubscription{ID: quota.ChildID, Name: quota.Name, Models: quota.Models, State: "available", ExpiresAt: quota.ExpiresAt}
		parts := []string{}
		switch {
		case quota.Unavailable:
			grant.State = "unavailable"
			parts = append(parts, "暂时不可用")
		case quota.BalanceBilled:
			grant.State = "balance_billed"
			parts = append(parts, "按现金余额计费")
		case len(quota.Windows) == 0:
			grant.State = "unknown"
			parts = append(parts, "等待额度观测")
		}
		for _, window := range quota.Windows {
			w := magpieQuotaWindow{ResetsAt: window.ResetsAt, State: "available",
				SettledUSD: float64(window.SettledNanoUSD) / 1e9, ReservedUSD: float64(window.ReservedNanoUSD) / 1e9}
			if window.LimitNanoUSD >= 0 {
				limit := float64(window.LimitNanoUSD) / 1e9
				w.LimitUSD = &limit
			}
			var text string
			switch {
			case quota.Unavailable:
				w.State = "unavailable"
				text = "暂时不可用"
			case window.LimitNanoUSD < 0:
				w.State = "unknown"
				text = "额度未知"
			case !window.ResetsAt.After(now):
				w.State = "awaiting_refresh"
				text = "等待刷新"
			default:
				remaining := 0.0
				if window.LimitNanoUSD > 0 {
					remaining = max(0, min(1, 1-float64(window.SettledNanoUSD)/float64(window.LimitNanoUSD)-float64(window.ReservedNanoUSD)/float64(window.LimitNanoUSD)))
				}
				w.Remaining = &remaining
				text = fmt.Sprintf("剩余 %.1f%%", remaining*100)
				if remaining == 0 {
					w.State = "exhausted"
				}
				if window.ReservedNanoUSD > 0 {
					text += "（含处理中预留）"
				}
				if quota.ExpiresAt != nil && !window.ResetsAt.Before(*quota.ExpiresAt) {
					text += "，订阅到期前不重置"
				} else {
					text += "，重置 " + window.ResetsAt.UTC().Format("2006-01-02 15:04 UTC")
				}
			}
			if grant.State == "available" && w.State != "available" {
				grant.State = w.State
			}
			windows[magpieQuotaID(window.Kind)] = w
			parts = append(parts, window.Kind+" "+text)
		}
		document.Subscriptions[magpieQuotaID(quota.ChildID)] = windows
		document.Grants = append(document.Grants, grant)
		name := strings.Join(strings.Fields(quota.Name), " ")
		if name == "" {
			name = "订阅"
		}
		if len(quota.Models) > 0 {
			name += " [" + strings.Join(quota.Models, ", ") + "]"
		}
		if quota.ExpiresAt != nil {
			name += "（有效至 " + quota.ExpiresAt.UTC().Format("2006-01-02 15:04 UTC") + "）"
		}
		summaries = append(summaries, name+"："+strings.Join(parts, "；"))
	}
	document.SubscriptionSummary = strings.Join(summaries, " | ")
	if document.SubscriptionSummary == "" {
		document.SubscriptionSummary = "此密钥暂无适用订阅；现金模型按余额计费"
	}
	return document
}

func (a *App) magpieQuotas(r *http.Request, key store.KeyContext) ([]store.SubscriptionQuota, error) {
	var models []string
	if a.nativeRuntime != nil {
		models = a.nativeRuntime.Models()
	}
	return a.store.SubscriptionQuotas(r.Context(), key, models, time.Now())
}

func (a *App) magpieBalance(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	key, err := a.store.ResolveKey(r.Context(), bearer(r))
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}
	quotas, err := a.magpieQuotas(r, key)
	if err != nil {
		writeError(w, 500, "quota_unavailable", "额度查询失败")
		return
	}
	var models []string
	if a.nativeRuntime != nil {
		models = a.nativeRuntime.Models()
	}
	writeJSON(w, http.StatusOK, projectMagpieUsage(key, quotas, models, time.Now()))
}

// Session ownership is checked before resolving or revealing any key material.
func (a *App) magpieKey(w http.ResponseWriter, r *http.Request) (string, store.KeyContext, bool) {
	setSensitiveNoStore(w)
	plain, err := a.store.RevealKey(r.Context(), currentSession(r).TenantID, r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "not_found", "密钥不存在或无法恢复，请创建新密钥")
		return "", store.KeyContext{}, false
	}
	key, err := a.store.ResolveKey(r.Context(), plain)
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, 401, "invalid_api_key", "API Key 无效或已停用")
		return "", store.KeyContext{}, false
	}
	return plain, key, true
}

func (a *App) magpieImport(w http.ResponseWriter, r *http.Request) {
	plain, key, ok := a.magpieKey(w, r)
	if !ok {
		return
	}
	base := strings.TrimRight(a.cfg.PublicURL, "/")
	var runtimeModels []string
	if a.nativeRuntime != nil {
		runtimeModels = a.nativeRuntime.Models()
	}
	capabilities := a.raiCodexCapabilities(key, visibleClientModels(key, runtimeModels))
	quotas, err := a.magpieQuotas(r, key)
	if err != nil {
		writeError(w, 500, "quota_unavailable", "额度查询失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"href": magpieImportURL(base, plain, key.APIKey),
		"name": magpieName(base, key.Name), "base_url": base + "/v1", "key": plain, "protocol": "responses", "balance_supported": strings.HasPrefix(base, "https://"),
		"configure_command": magpieConfigureCommand(base, key.APIKey, capabilities.WebSockets) + " billing=" + magpieBilling(key, quotas, runtimeModels),
	})
}

func magpieName(base, keyName string) string {
	name := "RelayAPI"
	if u, err := url.Parse(base); err == nil && u.Hostname() != "" {
		name += " · " + u.Hostname()
	}
	if keyName = strings.Join(strings.Fields(keyName), " "); keyName != "" {
		name += " · " + keyName
	}
	if len(name) > 80 {
		end := 80
		for !utf8.RuneStart(name[end]) {
			end--
		}
		name = name[:end]
	}
	return name
}

var magpieSlugPattern = regexp.MustCompile(`[^a-z0-9]+`)

// Import links cannot carry Socket or NativeCompaction. Use Magpie's supported
// provider-set interface after import, without placing a secret in shell history.
func magpieConfigureCommand(base string, key store.APIKey, sockets bool) string {
	socket := "off"
	if sockets {
		socket = "auto"
	}
	id := strings.Trim(magpieSlugPattern.ReplaceAllString(strings.ToLower(magpieProviderID(base, key)), "-"), "-")
	return "magpie provider set " + id + " compaction=native socket=" + socket
}

func magpieProviderID(base string, key store.APIKey) string {
	u, _ := url.Parse(base)
	host := ""
	if u != nil {
		host = u.Host
	}
	return "relayapi-" + host + "-" + key.ID
}

func magpieImportURL(publicURL, plain string, key store.APIKey) string {
	base := strings.TrimRight(publicURL, "/")
	params := url.Values{"name": {magpieName(base, key.Name)}, "responses": {base + "/v1"}, "key": {plain}}
	if key.ID != "" {
		params.Set("id", magpieProviderID(base, key))
	}
	// Magpie accepts HTTPS balance URLs on the endpoint's own host only.
	if strings.HasPrefix(base, "https://") {
		params.Set("website", base)
		params.Set("keys", base+"/app/keys")
		params.Set("balance", base+"/v1/usage")
		params.Set("balance_path", magpieBalancePath)
	}
	return "https://usemagpie.ai/import#" + params.Encode()
}
