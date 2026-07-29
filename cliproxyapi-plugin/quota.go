package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	hostAuthGet        = "host.auth.get"
	hostAuthGetRuntime = "host.auth.get_runtime"
	hostHTTPDo         = "host.http.do"
)

//go:embed quota-adapters.yaml
var bundledQuotaAdapters []byte

var hostCallback = callHost

type quotaAdapter struct {
	ID        string                `yaml:"id" json:"id"`
	Providers []string              `yaml:"providers" json:"providers"`
	Source    string                `yaml:"source" json:"source"`
	Requests  []quotaAdapterRequest `yaml:"requests" json:"requests"`
	Plan      *quotaValueSpec       `yaml:"plan,omitempty" json:"plan,omitempty"`
	Windows   []quotaWindowSpec     `yaml:"windows" json:"windows"`
}

type quotaAdapterRequest struct {
	ID       string            `yaml:"id" json:"id"`
	Method   string            `yaml:"method" json:"method"`
	URL      string            `yaml:"url" json:"url"`
	Headers  map[string]string `yaml:"headers" json:"headers"`
	Body     string            `yaml:"body,omitempty" json:"body,omitempty"`
	Optional bool              `yaml:"optional,omitempty" json:"optional,omitempty"`
}

type quotaValueSpec struct {
	Request string            `yaml:"request" json:"request"`
	Path    string            `yaml:"path" json:"path"`
	Map     map[string]string `yaml:"map,omitempty" json:"map,omitempty"`
}

type quotaWindowSpec struct {
	Kind             string `yaml:"kind" json:"kind"`
	Label            string `yaml:"label" json:"label"`
	Request          string `yaml:"request" json:"request"`
	UsedPercentPath  string `yaml:"used_percent_path,omitempty" json:"used_percent_path,omitempty"`
	RemainingPath    string `yaml:"remaining_percent_path,omitempty" json:"remaining_percent_path,omitempty"`
	UsedValuePath    string `yaml:"used_value_path,omitempty" json:"used_value_path,omitempty"`
	LimitValuePath   string `yaml:"limit_value_path,omitempty" json:"limit_value_path,omitempty"`
	ResetPath        string `yaml:"reset_path,omitempty" json:"reset_path,omitempty"`
	Enforceable      bool   `yaml:"enforceable" json:"enforceable"`
	Unit             string `yaml:"unit,omitempty" json:"unit,omitempty"`
	LimitPath        string `yaml:"limit_path,omitempty" json:"limit_path,omitempty"`
	RemainingRawPath string `yaml:"remaining_path,omitempty" json:"remaining_path,omitempty"`
}

type quotaReport struct {
	AuthIndex string        `json:"auth_index"`
	Provider  string        `json:"provider"`
	PlanType  string        `json:"plan_type,omitempty"`
	Supported bool          `json:"supported"`
	Source    string        `json:"source,omitempty"`
	Observed  time.Time     `json:"observed_at"`
	Windows   []quotaWindow `json:"windows"`
}

type quotaWindow struct {
	Kind             string     `json:"kind"`
	Label            string     `json:"label,omitempty"`
	UsedPercent      *float64   `json:"used_percent,omitempty"`
	RemainingPercent *float64   `json:"remaining_percent,omitempty"`
	ResetsAt         *time.Time `json:"resets_at,omitempty"`
	Enforceable      bool       `json:"enforceable"`
	Unit             string     `json:"unit,omitempty"`
	Limit            *float64   `json:"limit,omitempty"`
	Remaining        *float64   `json:"remaining,omitempty"`
}

type hostAuthGetResponse struct {
	AuthIndex string          `json:"auth_index"`
	Name      string          `json:"name"`
	JSON      json.RawMessage `json:"json"`
}

type hostAuthRuntimeResponse struct {
	Auth struct {
		AuthIndex string `json:"auth_index"`
		Type      string `json:"type"`
		Provider  string `json:"provider"`
	} `json:"auth"`
}

type hostHTTPRequest struct {
	Method  string      `json:"method"`
	URL     string      `json:"url"`
	Headers http.Header `json:"headers,omitempty"`
	Body    []byte      `json:"body,omitempty"`
}

type hostHTTPResponse struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}

func loadQuotaAdapters(mode string, configured []quotaAdapter) ([]quotaAdapter, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "append"
	}
	if mode == "disabled" {
		return []quotaAdapter{}, nil
	}
	if mode != "append" && mode != "replace" {
		return nil, fmt.Errorf("quota_adapters_mode must be append, replace, or disabled")
	}
	rawAdapters := make([]quotaAdapter, 0, len(configured)+4)
	if mode == "append" {
		var bundled struct {
			Adapters []quotaAdapter `yaml:"adapters"`
		}
		if err := yaml.Unmarshal(bundledQuotaAdapters, &bundled); err != nil {
			return nil, fmt.Errorf("decode bundled quota adapter pack: %w", err)
		}
		rawAdapters = append(rawAdapters, bundled.Adapters...)
	}
	rawAdapters = append(rawAdapters, configured...)
	adapters := make([]quotaAdapter, 0, len(rawAdapters))
	positions := map[string]int{}
	for index := range rawAdapters {
		adapter := &rawAdapters[index]
		adapter.ID = slug(adapter.ID)
		adapter.Source = strings.TrimSpace(adapter.Source)
		if adapter.ID == "" || len(adapter.Providers) == 0 || len(adapter.Requests) == 0 || len(adapter.Windows) == 0 {
			return nil, fmt.Errorf("quota adapter %d requires id, providers, requests, and windows", index)
		}
		for providerIndex := range adapter.Providers {
			adapter.Providers[providerIndex] = normalizedProvider(adapter.Providers[providerIndex])
			if adapter.Providers[providerIndex] == "" {
				return nil, fmt.Errorf("quota adapter %s has an empty provider key", adapter.ID)
			}
		}
		if err := validateQuotaAdapter(*adapter); err != nil {
			return nil, fmt.Errorf("quota adapter %s: %w", adapter.ID, err)
		}
		if position, exists := positions[adapter.ID]; exists {
			// Later entries deliberately replace earlier entries. In append mode this
			// lets an administrator override a bundled adapter without changing Go.
			adapters[position] = *adapter
			continue
		}
		positions[adapter.ID] = len(adapters)
		adapters = append(adapters, *adapter)
	}
	return adapters, nil
}

func validateQuotaAdapter(adapter quotaAdapter) error {
	requests := map[string]struct{}{}
	for _, request := range adapter.Requests {
		id := slug(request.ID)
		if id == "" || strings.TrimSpace(request.URL) == "" {
			return errors.New("request id and url are required")
		}
		if _, exists := requests[id]; exists {
			return fmt.Errorf("duplicate request id %q", id)
		}
		requests[id] = struct{}{}
	}
	if adapter.Plan != nil {
		if _, exists := requests[slug(adapter.Plan.Request)]; !exists {
			return fmt.Errorf("plan references unknown request %q", adapter.Plan.Request)
		}
		if strings.TrimSpace(adapter.Plan.Path) == "" {
			return errors.New("plan path is required")
		}
	}
	for _, window := range adapter.Windows {
		if slug(window.Kind) == "" {
			return errors.New("window kind is required")
		}
		if _, exists := requests[slug(window.Request)]; !exists {
			return fmt.Errorf("window %s references unknown request %q", window.Kind, window.Request)
		}
		if window.UsedPercentPath == "" && window.RemainingPath == "" && (window.UsedValuePath == "" || window.LimitValuePath == "") && window.LimitPath == "" && window.RemainingRawPath == "" {
			return fmt.Errorf("window %s has no quota value mapping", window.Kind)
		}
	}
	return nil
}

func probeQuota(authIndex string, adapters []quotaAdapter, now time.Time) (quotaReport, int, error) {
	if authIndex == "" {
		return quotaReport{}, http.StatusBadRequest, errors.New("auth_index is required")
	}
	runtimeRaw, err := hostCallback(hostAuthGetRuntime, map[string]string{"auth_index": authIndex})
	if err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("read CPA auth runtime metadata: %w", err)
	}
	var runtime hostAuthRuntimeResponse
	if err := json.Unmarshal(runtimeRaw, &runtime); err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("decode CPA auth runtime metadata: %w", err)
	}
	authRaw, err := hostCallback(hostAuthGet, map[string]string{"auth_index": authIndex})
	if err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("read CPA auth material: %w", err)
	}
	var stored hostAuthGetResponse
	if err := json.Unmarshal(authRaw, &stored); err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("decode CPA auth material: %w", err)
	}
	var auth map[string]any
	if err := json.Unmarshal(stored.JSON, &auth); err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("decode CPA credential JSON: %w", err)
	}
	provider := normalizedProvider(firstText(runtime.Auth.Provider, runtime.Auth.Type, scalarText(auth["provider"]), scalarText(auth["type"])))
	if embedded, ok := embeddedQuotaReport(auth, provider, authIndex, now); ok {
		return embedded, http.StatusOK, nil
	}
	adapter, ok := matchQuotaAdapter(adapters, provider)
	if !ok {
		return quotaReport{AuthIndex: authIndex, Provider: provider, Supported: false, Observed: now, Windows: []quotaWindow{}}, http.StatusOK, nil
	}
	report, err := runQuotaAdapter(adapter, auth, now)
	if err != nil {
		return quotaReport{}, http.StatusBadGateway, fmt.Errorf("quota adapter %s: %w", adapter.ID, err)
	}
	report.AuthIndex = authIndex
	report.Provider = provider
	report.Supported = true
	report.Observed = now
	return report, http.StatusOK, nil
}

func matchQuotaAdapter(adapters []quotaAdapter, provider string) (quotaAdapter, bool) {
	provider = normalizedProvider(provider)
	for index := len(adapters) - 1; index >= 0; index-- {
		for _, candidate := range adapters[index].Providers {
			if candidate == "*" || normalizedProvider(candidate) == provider {
				return adapters[index], true
			}
		}
	}
	return quotaAdapter{}, false
}

func runQuotaAdapter(adapter quotaAdapter, auth map[string]any, now time.Time) (quotaReport, error) {
	responses := make(map[string]any, len(adapter.Requests))
	succeeded := 0
	for _, spec := range adapter.Requests {
		response, err := executeQuotaRequest(spec, auth)
		if err != nil {
			if spec.Optional {
				continue
			}
			return quotaReport{}, fmt.Errorf("request %s: %w", spec.ID, err)
		}
		responses[slug(spec.ID)] = response
		succeeded++
	}
	if succeeded == 0 {
		return quotaReport{}, errors.New("all quota requests failed")
	}
	windows := make([]quotaWindow, 0, len(adapter.Windows))
	for _, spec := range adapter.Windows {
		response, exists := responses[slug(spec.Request)]
		if !exists {
			continue
		}
		if window, ok := mapQuotaWindow(spec, response, now); ok {
			windows = append(windows, window)
		}
	}
	if len(windows) == 0 {
		return quotaReport{}, errors.New("responses contain no mapped quota windows")
	}
	plan := ""
	if adapter.Plan != nil {
		if response, exists := responses[slug(adapter.Plan.Request)]; exists {
			plan = mappedValue(*adapter.Plan, response)
		}
	}
	return quotaReport{PlanType: plan, Source: firstText(adapter.Source, adapter.ID), Windows: validQuotaWindows(windows, now)}, nil
}

func executeQuotaRequest(spec quotaAdapterRequest, auth map[string]any) (any, error) {
	target, err := renderAuthTemplate(spec.URL, auth)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, errors.New("adapter URL must be an absolute HTTP(S) URL")
	}
	headers := make(http.Header, len(spec.Headers))
	for name, template := range spec.Headers {
		value, err := renderAuthTemplate(template, auth)
		if err != nil {
			return nil, fmt.Errorf("header %s: %w", name, err)
		}
		headers.Set(name, value)
	}
	body := []byte(nil)
	if spec.Body != "" {
		value, err := renderAuthTemplate(spec.Body, auth)
		if err != nil {
			return nil, fmt.Errorf("body: %w", err)
		}
		body = []byte(value)
	}
	method := strings.ToUpper(strings.TrimSpace(spec.Method))
	if method == "" {
		method = http.MethodGet
	}
	raw, err := hostCallback(hostHTTPDo, hostHTTPRequest{Method: method, URL: target, Headers: headers, Body: body})
	if err != nil {
		return nil, err
	}
	var response hostHTTPResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode host HTTP response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
	}
	var decoded any
	if err := json.Unmarshal(response.Body, &decoded); err != nil {
		return nil, fmt.Errorf("decode upstream JSON: %w", err)
	}
	return decoded, nil
}

func mapQuotaWindow(spec quotaWindowSpec, response any, now time.Time) (quotaWindow, bool) {
	used := percentPtr(lookupPath(response, spec.UsedPercentPath))
	remainingPercent := percentPtr(lookupPath(response, spec.RemainingPath))
	if used == nil && spec.UsedValuePath != "" && spec.LimitValuePath != "" {
		usedValue := numericPtr(lookupPath(response, spec.UsedValuePath))
		limitValue := numericPtr(lookupPath(response, spec.LimitValuePath))
		if usedValue != nil && limitValue != nil && *limitValue > 0 {
			value := clamp(*usedValue / *limitValue * 100)
			used = &value
		}
	}
	if used == nil && remainingPercent != nil {
		value := clamp(100 - *remainingPercent)
		used = &value
	}
	if remainingPercent == nil {
		remainingPercent = complement(used)
	}
	limit := numericPtr(lookupPath(response, spec.LimitPath))
	remaining := numericPtr(lookupPath(response, spec.RemainingRawPath))
	reset := parseTime(lookupPath(response, spec.ResetPath), now)
	if used == nil && remainingPercent == nil && limit == nil && remaining == nil {
		return quotaWindow{}, false
	}
	return quotaWindow{
		Kind: slug(spec.Kind), Label: firstText(spec.Label, spec.Kind), UsedPercent: used, RemainingPercent: remainingPercent,
		ResetsAt: reset, Enforceable: spec.Enforceable, Unit: strings.TrimSpace(spec.Unit), Limit: limit, Remaining: remaining,
	}, true
}

func mappedValue(spec quotaValueSpec, response any) string {
	value := scalarText(lookupPath(response, spec.Path))
	if value == "" {
		return ""
	}
	if mapped := spec.Map[value]; mapped != "" {
		return mapped
	}
	if number := numericPtr(lookupPath(response, spec.Path)); number != nil {
		normalized := strconv.FormatFloat(*number, 'f', -1, 64)
		if mapped := spec.Map[normalized]; mapped != "" {
			return mapped
		}
	}
	return value
}

func embeddedQuotaReport(auth map[string]any, provider, authIndex string, now time.Time) (quotaReport, bool) {
	root, _ := firstValue(auth["relay_quota"], auth["relayQuota"]).(map[string]any)
	if root == nil {
		return quotaReport{}, false
	}
	rows, _ := root["windows"].([]any)
	windows := make([]quotaWindow, 0, len(rows))
	for _, raw := range rows {
		item, _ := raw.(map[string]any)
		kind := slug(firstText(scalarText(item["kind"]), scalarText(item["id"])))
		if kind == "" {
			continue
		}
		used := percentPtr(firstValue(item["used_percent"], item["usedPercent"]))
		remaining := percentPtr(firstValue(item["remaining_percent"], item["remainingPercent"]))
		if used == nil && remaining != nil {
			value := clamp(100 - *remaining)
			used = &value
		}
		if remaining == nil {
			remaining = complement(used)
		}
		enforceable, _ := item["enforceable"].(bool)
		windows = append(windows, quotaWindow{
			Kind: kind, Label: firstText(scalarText(item["label"]), kind), UsedPercent: used, RemainingPercent: remaining,
			ResetsAt: parseTime(firstValue(item["resets_at"], item["resetsAt"]), now), Enforceable: enforceable,
			Unit: scalarText(item["unit"]), Limit: numericPtr(item["limit"]), Remaining: numericPtr(item["remaining"]),
		})
	}
	windows = validQuotaWindows(windows, now)
	if len(windows) == 0 {
		return quotaReport{}, false
	}
	return quotaReport{AuthIndex: authIndex, Provider: provider, PlanType: scalarText(root["plan_type"]), Supported: true, Source: "cpa-auth-extension", Observed: now, Windows: windows}, true
}

var authTemplatePattern = regexp.MustCompile(`\$\{auth\.([A-Za-z0-9_.-]+)\}`)

func renderAuthTemplate(template string, auth map[string]any) (string, error) {
	var renderErr error
	result := authTemplatePattern.ReplaceAllStringFunc(template, func(match string) string {
		parts := authTemplatePattern.FindStringSubmatch(match)
		value := scalarText(lookupPath(auth, parts[1]))
		if value == "" {
			renderErr = fmt.Errorf("credential field %s is missing", parts[1])
			return ""
		}
		return value
	})
	return result, renderErr
}

func lookupPath(value any, path string) any {
	path = strings.Trim(strings.TrimSpace(path), ".")
	if path == "" {
		return nil
	}
	current := value
	for _, segment := range strings.Split(path, ".") {
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

func validQuotaWindows(items []quotaWindow, now time.Time) []quotaWindow {
	result := make([]quotaWindow, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		item.Kind = slug(item.Kind)
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

func parseTime(value any, now time.Time) *time.Time {
	if number := numericPtr(value); number != nil && *number > 0 {
		seconds := *number
		if seconds > 1e12 {
			seconds /= 1000
		}
		result := time.Unix(int64(seconds), 0).UTC()
		return &result
	}
	text := scalarText(value)
	if text == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, text); err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	if duration, err := time.ParseDuration(text); err == nil {
		result := now.Add(duration).UTC()
		return &result
	}
	return nil
}

func normalizedProvider(value string) string {
	// Provider identities are opaque extension keys. Provider-specific aliases
	// belong in the adapter manifest, never in the bridge runtime.
	if strings.TrimSpace(value) == "*" {
		return "*"
	}
	return slug(value)
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func slug(value string) string {
	value = strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	if len(value) > 80 {
		value = value[:80]
	}
	return value
}

func scalarText(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}

func firstText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func numericPtr(value any) *float64 {
	var result float64
	switch typed := value.(type) {
	case float64:
		result = typed
	case float32:
		result = float64(typed)
	case int:
		result = float64(typed)
	case int64:
		result = float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil
		}
		result = parsed
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

func percentPtr(value any) *float64 {
	result := numericPtr(value)
	if result == nil {
		return nil
	}
	clamped := clamp(*result)
	return &clamped
}

func complement(used *float64) *float64 {
	if used == nil {
		return nil
	}
	result := clamp(100 - *used)
	return &result
}

func clamp(value float64) float64 {
	return math.Max(0, math.Min(100, value))
}
