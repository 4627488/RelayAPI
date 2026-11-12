package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/metering"
)

// UsageTotals is shared by every attribution and archive, so a filter or
// retention cannot change a metric's definition between cards and rankings.
type UsageTotals struct {
	Requests                   int64    `json:"requests"`
	Errors                     int64    `json:"errors"`
	Canceled                   int64    `json:"canceled"`
	Rejected                   int64    `json:"rejected"`
	Retried                    int64    `json:"retried"`
	Unpriced                   int64    `json:"unpriced"`
	Tokens                     int64    `json:"tokens"`
	PromptTokens               int64    `json:"input"`
	CompletionTokens           int64    `json:"output"`
	CachedTokens               int64    `json:"cache_read"`
	CacheWriteTokens           int64    `json:"cache_write"`
	CacheWrite1hTokens         int64    `json:"cache_write_1h"`
	CacheUnknownTokens         int64    `json:"cache_unknown"`
	CacheUnknownReadTokens     int64    `json:"cache_unknown_read"`
	CacheUnknownCalls          int64    `json:"cache_unknown_calls"`
	ReasoningTokens            int64    `json:"reasoning"`
	ImageInputTokens           int64    `json:"image_input_tokens"`
	CachedImageInputTokens     int64    `json:"cached_image_input_tokens"`
	ImageOutputTokens          int64    `json:"image_output_tokens"`
	CostNanoUSD                int64    `json:"cost_nano_usd"`
	SubscriptionCoveredNanoUSD int64    `json:"subscription_covered_nano_usd"`
	BalanceChargedNanoUSD      int64    `json:"balance_charged_nano_usd"`
	Timed                      int64    `json:"timed"`
	TTFTSumMS                  int64    `json:"ttft_ms"`
	DecodeOut                  int64    `json:"decode_out"`
	DecodeMS                   int64    `json:"decode_ms"`
	DecodeN                    int64    `json:"decode_n"`
	CacheHitRate               *float64 `json:"cache_hit_rate" gorm:"-"`
	MeanTTFTMS                 *float64 `json:"mean_ttft_ms" gorm:"-"`
	TokensPerSecond            *float64 `json:"tokens_per_second" gorm:"-"`
}

func (t *UsageTotals) add(v UsageTotals) {
	t.Requests += v.Requests
	t.Errors += v.Errors
	t.Canceled += v.Canceled
	t.Rejected += v.Rejected
	t.Retried += v.Retried
	t.Unpriced += v.Unpriced
	t.PromptTokens += v.PromptTokens
	t.CompletionTokens += v.CompletionTokens
	t.CachedTokens += v.CachedTokens
	t.CacheWriteTokens += v.CacheWriteTokens
	t.CacheWrite1hTokens += v.CacheWrite1hTokens
	t.CacheUnknownTokens += v.CacheUnknownTokens
	t.CacheUnknownCalls += v.CacheUnknownCalls
	t.CacheUnknownReadTokens += v.CacheUnknownReadTokens
	t.ReasoningTokens += v.ReasoningTokens
	t.ImageInputTokens += v.ImageInputTokens
	t.CachedImageInputTokens += v.CachedImageInputTokens
	t.ImageOutputTokens += v.ImageOutputTokens
	t.CostNanoUSD += v.CostNanoUSD
	t.SubscriptionCoveredNanoUSD += v.SubscriptionCoveredNanoUSD
	t.BalanceChargedNanoUSD += v.BalanceChargedNanoUSD
	t.Timed += v.Timed
	t.TTFTSumMS += v.TTFTSumMS
	t.DecodeOut += v.DecodeOut
	t.DecodeMS += v.DecodeMS
	t.DecodeN += v.DecodeN
}
func (t *UsageTotals) finish() {
	t.CacheHitRate = nil
	t.MeanTTFTMS = nil
	t.TokensPerSecond = nil
	t.Tokens = metering.Add(t.PromptTokens, t.CompletionTokens)
	p := metering.Add(t.PromptTokens, t.CachedTokens, t.CacheWriteTokens) - t.CacheUnknownTokens
	if p > 0 {
		n := float64(max(int64(0), min(p, t.CachedTokens-t.CacheUnknownReadTokens))) / float64(p)
		t.CacheHitRate = &n
	}
	if t.Timed > 0 {
		n := float64(t.TTFTSumMS) / float64(t.Timed)
		t.MeanTTFTMS = &n
	}
	if t.DecodeMS > 0 {
		n := float64(t.DecodeOut) * 1000 / float64(t.DecodeMS)
		t.TokensPerSecond = &n
	}
}

type usageGroup struct {
	UsageTotals  `gorm:"embedded"`
	Date         string `json:"date,omitempty"`
	Model        string `json:"model,omitempty"`
	TenantID     string `json:"tenant_id,omitempty"`
	TenantName   string `json:"tenant_name,omitempty"`
	APIKeyID     string `json:"api_key_id,omitempty"`
	APIKeyName   string `json:"api_key_name,omitempty"`
	APIKeyPrefix string `json:"api_key_prefix,omitempty"`
}

// Every archive and report shares this additive metric list.
var usageFactColumns = []string{"requests", "errors", "canceled", "rejected", "retried", "unpriced", "prompt_tokens", "completion_tokens", "cached_tokens", "cache_write_tokens", "cache_write1h_tokens", "cache_unknown_tokens", "cache_unknown_read_tokens", "cache_unknown_calls", "reasoning_tokens", "image_input_tokens", "cached_image_input_tokens", "image_output_tokens", "cost_nano_usd", "subscription_covered_nano_usd", "balance_charged_nano_usd", "timed", "ttft_sum_ms", "decode_out", "decode_ms", "decode_n"}

const liveUsageFactsSQL = ` SELECT date_trunc('minute', started_at) AS day, tenant_id, model, api_key_id::text AS api_key_id,
 max(api_key_name) AS api_key_name, max(api_key_prefix) AS api_key_prefix,
 count(*) FILTER (WHERE NOT rejected) AS requests,
 count(*) FILTER (WHERE NOT rejected AND NOT canceled AND (status_code=0 OR status_code>=400 OR COALESCE(error_code,'')<>'')) AS errors,
 count(*) FILTER (WHERE canceled AND NOT rejected) AS canceled,
 count(*) FILTER (WHERE rejected) AS rejected,
 count(*) FILTER (WHERE tries>1 AND NOT rejected) AS retried,
 count(*) FILTER (WHERE NOT pricing_complete AND prompt_tokens+completion_tokens+cached_tokens+cache_write_tokens>0) AS unpriced,
 COALESCE(sum(prompt_tokens),0) AS prompt_tokens, COALESCE(sum(completion_tokens),0) AS completion_tokens,
 COALESCE(sum(cached_tokens),0) AS cached_tokens, COALESCE(sum(cache_write_tokens),0) AS cache_write_tokens,
 COALESCE(sum(cache_write1h_tokens),0) AS cache_write1h_tokens,
 COALESCE(sum(CASE WHEN cache_unknown THEN prompt_tokens+cached_tokens+cache_write_tokens ELSE 0 END),0) AS cache_unknown_tokens,
 COALESCE(sum(CASE WHEN cache_unknown THEN cached_tokens ELSE 0 END),0) AS cache_unknown_read_tokens,
 count(*) FILTER (WHERE cache_unknown) AS cache_unknown_calls,
 COALESCE(sum(reasoning_tokens),0) AS reasoning_tokens, COALESCE(sum(image_input_tokens),0) AS image_input_tokens,
 COALESCE(sum(cached_image_input_tokens),0) AS cached_image_input_tokens, COALESCE(sum(image_output_tokens),0) AS image_output_tokens,
 COALESCE(sum(CASE WHEN settled THEN cost_nano_usd ELSE 0 END),0) AS cost_nano_usd,
 COALESCE(sum(CASE WHEN settled AND billing_source='subscription' THEN cost_nano_usd ELSE 0 END),0) AS subscription_covered_nano_usd,
 COALESCE(sum(CASE WHEN settled AND billing_source='balance' THEN cost_nano_usd ELSE 0 END),0) AS balance_charged_nano_usd,
 count(*) FILTER (WHERE ttftms>0 AND status_code BETWEEN 200 AND 399 AND NOT canceled AND COALESCE(error_code,'')='') AS timed,
 COALESCE(sum(ttftms) FILTER (WHERE ttftms>0 AND status_code BETWEEN 200 AND 399 AND NOT canceled AND COALESCE(error_code,'')=''),0) AS ttft_sum_ms,
 COALESCE(sum(decode_out),0) AS decode_out, COALESCE(sum(decode_ms),0) AS decode_ms,
 count(*) FILTER (WHERE decode_ms>0) AS decode_n
`

// One statement sees the live rows and the archived rows at the same snapshot,
// including when retention moves a batch concurrently. The archive keeps key
// identity and all additive metrics. Percentiles stay in retained observations.
func (s Store) UsageReport(ctx context.Context, tenantID string, days int, zones ...string) (map[string]any, error) {
	all := days == -1
	if !all && (days < 1 || days > 365) {
		days = 30
	}
	zone := time.UTC
	if len(zones) > 0 && zones[0] != "" {
		var err error
		zone, err = time.LoadLocation(zones[0])
		if err != nil {
			return nil, err
		}
	}
	now := time.Now().In(zone)
	since := now.AddDate(0, 0, -days+1)
	since = time.Date(since.Year(), since.Month(), since.Day(), 0, 0, 0, 0, zone)
	if all {
		since = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)
		days = 0
	}
	var rows []usageGroup
	sums := make([]string, 0, len(usageFactColumns))
	for _, column := range usageFactColumns {
		sums = append(sums, "COALESCE(sum(facts."+column+"),0) AS "+column)
	}
	err := scoped(ctx, s.DB).Raw(`WITH facts AS (
 `+liveUsageFactsSQL+` FROM request_logs WHERE log_unit='step' AND started_at>=? AND started_at<=? AND (?='' OR tenant_id::text=?)
 GROUP BY 1,tenant_id,model,api_key_id
 UNION ALL
 SELECT day,tenant_id,model,api_key_id,api_key_name,api_key_prefix,requests,errors,canceled,rejected,retried,unpriced,
 prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens,cache_write1h_tokens,cache_unknown_tokens,cache_unknown_read_tokens,cache_unknown_calls,
 reasoning_tokens,image_input_tokens,cached_image_input_tokens,image_output_tokens,cost_nano_usd,subscription_covered_nano_usd,balance_charged_nano_usd,
 timed,ttft_sum_ms,decode_out,decode_ms,decode_n
 FROM usage_rollups_v2 WHERE day>=? AND day<=? AND (?='' OR tenant_id::text=?)
 ) SELECT to_char(day AT TIME ZONE ?,'YYYY-MM-DD') AS date,facts.tenant_id,facts.model,facts.api_key_id,max(facts.api_key_name) AS api_key_name,max(facts.api_key_prefix) AS api_key_prefix,COALESCE(tenants.name,'') AS tenant_name,`+strings.Join(sums, ",")+`
 FROM facts LEFT JOIN tenants ON tenants.id=facts.tenant_id
 GROUP BY 1,facts.tenant_id,facts.model,facts.api_key_id,tenants.name ORDER BY date,model,api_key_id`,
		since, now, tenantID, tenantID, since, now, tenantID, tenantID, zone.String()).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	var total UsageTotals
	daily, models, keys, users := map[string]*usageGroup{}, map[string]*usageGroup{}, map[string]*usageGroup{}, map[string]*usageGroup{}
	add := func(groups map[string]*usageGroup, key string, row usageGroup, identity usageGroup) {
		if groups[key] == nil {
			groups[key] = &identity
		}
		groups[key].UsageTotals.add(row.UsageTotals)
	}
	for _, r := range rows {
		total.add(r.UsageTotals)
		add(daily, r.Date, r, usageGroup{Date: r.Date})
		add(models, r.Model, r, usageGroup{Model: r.Model})
		name := r.APIKeyName
		if r.APIKeyID == "" {
			name = "历史归档（未记录 Key）"
		}
		add(keys, r.TenantID+"/"+r.APIKeyID, r, usageGroup{APIKeyID: r.APIKeyID, APIKeyName: name, APIKeyPrefix: r.APIKeyPrefix, TenantID: r.TenantID, TenantName: r.TenantName})
		if tenantID == "" {
			add(users, r.TenantID, r, usageGroup{TenantID: r.TenantID, TenantName: r.TenantName})
		}
	}
	list := func(m map[string]*usageGroup, byDate bool) []usageGroup {
		out := make([]usageGroup, 0, len(m))
		for _, v := range m {
			v.finish()
			out = append(out, *v)
		}
		sort.Slice(out, func(i, j int) bool {
			if byDate {
				return out[i].Date < out[j].Date
			}
			if out[i].Tokens != out[j].Tokens {
				return out[i].Tokens > out[j].Tokens
			}
			return out[i].Model+out[i].TenantID+out[i].APIKeyID < out[j].Model+out[j].TenantID+out[j].APIKeyID
		})
		return out
	}
	total.finish()
	observability, err := s.usageObservability(ctx, tenantID, since)
	if err != nil {
		return nil, err
	}
	return map[string]any{"metering_version": 2, "timezone": zone.String(), "period_start": since, "generated_at": now, "days": days, "user_id": tenantID,
		"summary": total, "daily": list(daily, true), "models": list(models, false), "api_keys": list(keys, false), "users": list(users, false), "observability": observability}, nil
}
