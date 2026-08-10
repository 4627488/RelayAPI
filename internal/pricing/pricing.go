// Package pricing resolves immutable, integer-valued model price snapshots.
//
// Its snapshot/resolver shape is adapted from CPA Usage Keeper's MIT-licensed
// pricing domain, with Relay-specific modality-aware pricing and source precedence.
package pricing

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
)

var modelDateSuffix = regexp.MustCompile(`-(?:\d{6,8}|\d{4}-\d{2}-\d{2})$`)

const (
	SourceAdmin   = "admin"
	SourceCatalog = "models.dev"
	SourceBundled = "bundled"
)

type Price struct {
	Model                           string  `json:"model"`
	InputNanoUSDPerToken            int64   `json:"input_nano_usd_per_token"`
	OutputNanoUSDPerToken           int64   `json:"output_nano_usd_per_token"`
	CachedInputNanoUSDPerToken      int64   `json:"cached_input_nano_usd_per_token"`
	CacheWriteNanoUSDPerToken       int64   `json:"cache_write_nano_usd_per_token"`
	ReasoningNanoUSDPerToken        int64   `json:"reasoning_nano_usd_per_token"`
	ImageInputNanoUSDPerToken       int64   `json:"image_input_nano_usd_per_token"`
	CachedImageInputNanoUSDPerToken int64   `json:"cached_image_input_nano_usd_per_token"`
	ImageOutputNanoUSDPerToken      int64   `json:"image_output_nano_usd_per_token"`
	Source                          string  `json:"source"`
	Version                         string  `json:"version"`
	PriceMultiplier                 float64 `json:"price_multiplier"`
}

type Rule struct {
	Model      string  `json:"model"`
	Field      string  `json:"field"`
	Value      string  `json:"value"`
	Multiplier float64 `json:"multiplier"`
}

type Dimensions struct {
	APIGroupKey         string `json:"api_group_key,omitempty"`
	Model               string `json:"model"`
	ModelAlias          string `json:"model_alias,omitempty"`
	AuthIndex           string `json:"auth_index,omitempty"`
	ServiceTier         string `json:"service_tier,omitempty"`
	ResponseServiceTier string `json:"response_service_tier,omitempty"`
	ReasoningEffort     string `json:"reasoning_effort,omitempty"`
	Endpoint            string `json:"endpoint,omitempty"`
	ExecutorType        string `json:"executor_type,omitempty"`
}

type SnapshotPrice struct {
	Price
	RequestedModel string  `json:"requested_model"`
	PricedModel    string  `json:"priced_model"`
	MatchedBy      string  `json:"matched_by"`
	RuleMultiplier float64 `json:"rule_multiplier"`
}

type compiledModel struct {
	price Price
	rules []Rule
}

type Snapshot struct {
	admin   map[string]compiledModel
	catalog map[string]compiledModel
	bundled map[string]compiledModel
	aliases map[string]string
}

func Compile(admin, catalog, bundled []Price, aliases map[string]string, rules []Rule) (*Snapshot, error) {
	result := &Snapshot{
		admin: make(map[string]compiledModel), catalog: make(map[string]compiledModel),
		bundled: make(map[string]compiledModel), aliases: make(map[string]string),
	}
	rulesByModel := make(map[string][]Rule)
	for _, rule := range rules {
		rule.Model = clean(rule.Model)
		rule.Field = strings.ToLower(clean(rule.Field))
		rule.Value = clean(rule.Value)
		if rule.Model == "" || rule.Value == "" || !ValidRuleField(rule.Field) {
			return nil, fmt.Errorf("invalid price rule for model %q", rule.Model)
		}
		if !finiteNonNegative(rule.Multiplier) {
			return nil, fmt.Errorf("invalid multiplier for model %q", rule.Model)
		}
		ruleKey := strings.ToLower(rule.Model)
		rulesByModel[ruleKey] = append(rulesByModel[ruleKey], rule)
	}
	compileSet := func(destination map[string]compiledModel, prices []Price) error {
		for _, price := range prices {
			price.Model = clean(price.Model)
			if price.Model == "" {
				return errors.New("price model is required")
			}
			if price.PriceMultiplier == 0 {
				// Zero is an intentional free-model multiplier. Older rows are
				// backfilled to one by Store before reaching the compiler.
			} else if !finiteNonNegative(price.PriceMultiplier) {
				return fmt.Errorf("invalid price multiplier for %q", price.Model)
			}
			for _, value := range []int64{
				price.InputNanoUSDPerToken, price.OutputNanoUSDPerToken,
				price.CachedInputNanoUSDPerToken, price.CacheWriteNanoUSDPerToken,
				price.ReasoningNanoUSDPerToken, price.ImageInputNanoUSDPerToken,
				price.CachedImageInputNanoUSDPerToken, price.ImageOutputNanoUSDPerToken,
			} {
				if value < 0 {
					return fmt.Errorf("negative price for %q", price.Model)
				}
			}
			key := strings.ToLower(price.Model)
			destination[key] = compiledModel{price: price, rules: append([]Rule(nil), rulesByModel[key]...)}
		}
		return nil
	}
	if err := compileSet(result.admin, admin); err != nil {
		return nil, err
	}
	if err := compileSet(result.catalog, catalog); err != nil {
		return nil, err
	}
	if err := compileSet(result.bundled, bundled); err != nil {
		return nil, err
	}
	for alias, model := range aliases {
		alias, model = clean(alias), clean(model)
		if alias == "" || model == "" {
			return nil, errors.New("model alias and target are required")
		}
		result.aliases[strings.ToLower(alias)] = model
	}
	return result, nil
}

func (s *Snapshot) Resolve(dimensions Dimensions) (SnapshotPrice, bool) {
	if s == nil {
		return SnapshotPrice{}, false
	}
	requested := clean(dimensions.Model)
	if requested == "" {
		return SnapshotPrice{}, false
	}
	priced := requested
	matchedBy := "model"
	if target, ok := s.aliases[strings.ToLower(requested)]; ok {
		priced = target
		matchedBy = "alias"
	}
	if dimensions.ModelAlias != "" {
		if target, ok := s.aliases[strings.ToLower(clean(dimensions.ModelAlias))]; ok {
			priced = target
			matchedBy = "cpa_model_alias"
		}
	}
	candidates := modelCandidates(priced)
	for sourceIndex, source := range []map[string]compiledModel{s.admin, s.catalog, s.bundled} {
		for _, candidate := range candidates {
			model, ok := source[strings.ToLower(candidate)]
			if !ok {
				continue
			}
			// Legacy administrator rows and token catalogs that only expose one
			// input/output rate cannot safely price multimodal image models. Prefer
			// the modality-aware bundled entry. An all-zero administrator row is
			// still an intentional free-model override.
			if sourceIndex < 2 && !hasImagePricing(model.price) && hasImagePriceCandidate(s.bundled, candidates) {
				if sourceIndex != 0 || (hasAnyPrice(model.price) && model.price.PriceMultiplier != 0) {
					continue
				}
			}
			ruleMultiplier := matchingRuleMultiplier(model.rules, dimensions)
			price := scaled(model.price, ruleMultiplier)
			return SnapshotPrice{
				Price: price, RequestedModel: requested, PricedModel: model.price.Model,
				MatchedBy: matchedBy, RuleMultiplier: ruleMultiplier,
			}, true
		}
	}
	return SnapshotPrice{}, false
}

func modelCandidates(model string) []string {
	model = clean(model)
	result := []string{model}
	if slash := strings.LastIndex(model, "/"); slash >= 0 {
		result = append(result, model[slash+1:])
	} else {
		lower := strings.ToLower(model)
		switch {
		case strings.HasPrefix(lower, "grok-"):
			result = append(result, "xai/"+model)
		case strings.HasPrefix(lower, "claude-"):
			result = append(result, "anthropic/"+model)
		case strings.HasPrefix(lower, "gemini-"):
			result = append(result, "google/"+model)
		case strings.HasPrefix(lower, "deepseek-"):
			result = append(result, "deepseek/"+model)
		case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "codex-"),
			strings.HasPrefix(lower, "o1-"), strings.HasPrefix(lower, "o3-"), strings.HasPrefix(lower, "o4-"):
			result = append(result, "openai/"+model)
		}
	}
	initial := append([]string(nil), result...)
	for _, candidate := range initial {
		if stripped := modelDateSuffix.ReplaceAllString(candidate, ""); stripped != candidate {
			result = append(result, stripped)
		}
	}
	return unique(result)
}

func scaled(price Price, ruleMultiplier float64) Price {
	multiplier := price.PriceMultiplier
	if multiplier < 0 || math.IsNaN(multiplier) || math.IsInf(multiplier, 0) {
		multiplier = 1
	}
	total := multiplier * ruleMultiplier
	price.InputNanoUSDPerToken = scaleInt(price.InputNanoUSDPerToken, total)
	price.OutputNanoUSDPerToken = scaleInt(price.OutputNanoUSDPerToken, total)
	price.CachedInputNanoUSDPerToken = scaleInt(price.CachedInputNanoUSDPerToken, total)
	price.CacheWriteNanoUSDPerToken = scaleInt(price.CacheWriteNanoUSDPerToken, total)
	price.ReasoningNanoUSDPerToken = scaleInt(price.ReasoningNanoUSDPerToken, total)
	price.ImageInputNanoUSDPerToken = scaleInt(price.ImageInputNanoUSDPerToken, total)
	price.CachedImageInputNanoUSDPerToken = scaleInt(price.CachedImageInputNanoUSDPerToken, total)
	price.ImageOutputNanoUSDPerToken = scaleInt(price.ImageOutputNanoUSDPerToken, total)
	price.PriceMultiplier = total
	return price
}

func hasImagePricing(price Price) bool {
	return price.ImageInputNanoUSDPerToken != 0 || price.CachedImageInputNanoUSDPerToken != 0 ||
		price.ImageOutputNanoUSDPerToken != 0
}

func hasImagePriceCandidate(models map[string]compiledModel, candidates []string) bool {
	for _, candidate := range candidates {
		if model, ok := models[strings.ToLower(candidate)]; ok && hasImagePricing(model.price) {
			return true
		}
	}
	return false
}

func hasAnyPrice(price Price) bool {
	return price.InputNanoUSDPerToken != 0 || price.OutputNanoUSDPerToken != 0 ||
		price.CachedInputNanoUSDPerToken != 0 || price.CacheWriteNanoUSDPerToken != 0 ||
		price.ReasoningNanoUSDPerToken != 0 || hasImagePricing(price)
}

func scaleInt(value int64, multiplier float64) int64 {
	if multiplier == 0 || value == 0 {
		return 0
	}
	scaledValue := math.Round(float64(value) * multiplier)
	if scaledValue > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(scaledValue)
}

func matchingRuleMultiplier(rules []Rule, dimensions Dimensions) float64 {
	multiplier := 1.0
	for _, rule := range rules {
		if dimensionValue(dimensions, rule.Field) == rule.Value {
			multiplier *= rule.Multiplier
		}
	}
	return multiplier
}

func dimensionValue(d Dimensions, field string) string {
	switch field {
	case "api_group_key":
		return clean(d.APIGroupKey)
	case "model":
		return clean(d.Model)
	case "model_alias":
		return clean(d.ModelAlias)
	case "auth_index":
		return clean(d.AuthIndex)
	case "service_tier":
		return clean(d.ServiceTier)
	case "response_service_tier":
		return clean(d.ResponseServiceTier)
	case "reasoning_effort":
		return clean(d.ReasoningEffort)
	case "endpoint":
		return clean(d.Endpoint)
	case "executor_type":
		return clean(d.ExecutorType)
	default:
		return ""
	}
}

func ValidRuleField(field string) bool {
	switch strings.ToLower(clean(field)) {
	case "api_group_key", "model", "model_alias", "auth_index", "service_tier",
		"response_service_tier", "reasoning_effort", "endpoint", "executor_type":
		return true
	default:
		return false
	}
}

type Catalog struct{ current atomic.Pointer[Snapshot] }

func NewCatalog(snapshot *Snapshot) *Catalog {
	catalog := &Catalog{}
	if snapshot != nil {
		catalog.current.Store(snapshot)
	}
	return catalog
}

func (c *Catalog) Replace(snapshot *Snapshot) {
	if c != nil && snapshot != nil {
		c.current.Store(snapshot)
	}
}

func (c *Catalog) Snapshot() *Snapshot {
	if c == nil {
		return nil
	}
	return c.current.Load()
}

func clean(value string) string { return strings.TrimSpace(value) }
func finiteNonNegative(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}
func unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
}

func SortedRuleFields() []string {
	fields := []string{"api_group_key", "model", "model_alias", "auth_index", "service_tier",
		"response_service_tier", "reasoning_effort", "endpoint", "executor_type"}
	sort.Strings(fields)
	return fields
}
