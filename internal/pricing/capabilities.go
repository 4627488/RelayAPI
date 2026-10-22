package pricing

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

// Capability is the models.dev fact sheet Relay uses for Codex ModelInfo:
// context, modalities, and advertised reasoning controls. It is not a price.
type Capability struct {
	ID               string
	Name             string
	Description      string
	Provider         string
	Source           string
	Context          int
	MaxOutput        int
	MaxInput         int
	ToolCall         *bool
	StructuredOutput *bool
	Temperature      *bool
	Reasoning        bool
	ReasoningOptions []ReasoningOption
	DefaultLevel     string
	InputModalities  []string
	OutputModalities []string
	ServiceTiers     []string
	PreferWebSockets *bool
}

type ReasoningOption struct {
	Type   string
	Values []string
}

type CapabilityIndex struct {
	version   string
	revision  string
	byKey     map[string]Capability
	overrides map[string]Capability
}

func NewCapabilityIndex(version string, capabilities []Capability) *CapabilityIndex {
	index := &CapabilityIndex{version: strings.TrimSpace(version), byKey: make(map[string]Capability, len(capabilities)*3), overrides: make(map[string]Capability)}
	for _, capability := range capabilities {
		index.add(capability)
	}
	payload, _ := json.Marshal([]map[string]Capability{index.byKey, index.overrides})
	index.revision = fmt.Sprintf("%s|sha256:%x", index.version, sha256.Sum256(payload))
	return index
}

func IndexFromCatalogPrices(version string, models []string, sourceIDs []string, rawJSON []string) *CapabilityIndex {
	capabilities := make([]Capability, 0, len(rawJSON))
	for i, raw := range rawJSON {
		sourceID := ""
		if i < len(sourceIDs) {
			sourceID = sourceIDs[i]
		}
		if capability, ok := CapabilityFromRawJSON(sourceID, raw); ok {
			capabilities = append(capabilities, capability)
		}
	}
	if version == "" && len(models) > 0 {
		version = "catalog"
	}
	return NewCapabilityIndex(version, capabilities)
}

func (idx *CapabilityIndex) Version() string {
	if idx == nil {
		return ""
	}
	return idx.version
}

func (idx *CapabilityIndex) Lookup(slug string) (Capability, bool) {
	base, found := idx.LookupCatalog(slug)
	if override, ok := idx.LookupOverride(slug); ok {
		return mergeCapability(base, override), true
	}
	return base, found
}

func (idx *CapabilityIndex) LookupCatalog(slug string) (Capability, bool) {
	if idx == nil {
		return Capability{}, false
	}
	return lookupCapability(idx.byKey, slug)
}

func (idx *CapabilityIndex) LookupOverride(slug string) (Capability, bool) {
	if idx == nil {
		return Capability{}, false
	}
	return lookupCapability(idx.overrides, slug)
}

func lookupCapability(items map[string]Capability, slug string) (Capability, bool) {
	for _, candidate := range modelCandidates(slug) {
		if capability, ok := items[strings.ToLower(strings.TrimSpace(candidate))]; ok {
			return capability, true
		}
	}
	return Capability{}, false
}

// Revision includes actual content: deleting a non-latest override must also
// invalidate the model catalog, even if its maximum updated_at is unchanged.
func (idx *CapabilityIndex) Revision() string {
	if idx == nil {
		return ""
	}
	return idx.revision
}

func mergeCapability(base, override Capability) Capability {
	base.ID, base.Source = override.ID, override.Source
	if override.Name != "" {
		base.Name = override.Name
	}
	if override.Description != "" {
		base.Description = override.Description
	}
	if override.MaxInput > 0 {
		base.MaxInput = override.MaxInput
	}
	if override.ToolCall != nil {
		base.ToolCall = override.ToolCall
	}
	if override.StructuredOutput != nil {
		base.StructuredOutput = override.StructuredOutput
	}
	if override.Temperature != nil {
		base.Temperature = override.Temperature
	}
	if len(override.OutputModalities) > 0 {
		base.OutputModalities = override.OutputModalities
	}
	if len(override.ServiceTiers) > 0 {
		base.ServiceTiers = override.ServiceTiers
	}
	if override.Provider != "" {
		base.Provider = override.Provider
	}
	if override.Context > 0 {
		base.Context = override.Context
	}
	if override.MaxOutput > 0 {
		base.MaxOutput = override.MaxOutput
	}
	if len(override.ReasoningOptions) > 0 {
		base.Reasoning, base.ReasoningOptions = override.Reasoning, override.ReasoningOptions
	}
	if override.DefaultLevel != "" {
		base.DefaultLevel = override.DefaultLevel
	}
	if len(override.InputModalities) > 0 {
		base.InputModalities = override.InputModalities
	}
	if override.PreferWebSockets != nil {
		base.PreferWebSockets = override.PreferWebSockets
	}
	return base
}

func (c Capability) EffortValues() []string {
	var effort []string
	for _, option := range c.ReasoningOptions {
		if option.Type == "effort" {
			effort = append(effort, option.Values...)
		}
	}
	return effort
}

func (idx *CapabilityIndex) add(capability Capability) {
	items := idx.byKey
	if capability.Source == SourceAdmin {
		items = idx.overrides
	}
	keys := []string{capability.ID, capability.Provider + "/" + bareModelID(capability.ID)}
	if bare := bareModelID(capability.ID); bare != "" {
		keys = append(keys, bare)
	}
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		if current, exists := items[key]; exists && !preferCapability(capability, current) {
			continue
		}
		items[key] = capability
	}
}

func CapabilityFromRawJSON(sourceModelID, raw string) (Capability, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Capability{}, false
	}
	var model modelsDevModel
	if json.Unmarshal([]byte(raw), &model) != nil {
		return Capability{}, false
	}
	provider, modelID := splitSourceModelID(sourceModelID)
	if modelID == "" {
		modelID = strings.TrimSpace(model.ID)
	}
	if modelID == "" {
		return Capability{}, false
	}
	return capabilityFromModelsDev(provider, modelID, model), true
}

func capabilityFromModelsDev(providerID, modelID string, model modelsDevModel) Capability {
	id := strings.TrimSpace(modelID)
	if providerID != "" && !strings.Contains(id, "/") {
		id = providerID + "/" + id
	}
	options := make([]ReasoningOption, 0, len(model.ReasoningOptions))
	for _, option := range model.ReasoningOptions {
		values := make([]string, 0, len(option.Values))
		for _, value := range option.Values {
			value = strings.ToLower(strings.TrimSpace(value))
			if value != "" {
				values = append(values, value)
			}
		}
		options = append(options, ReasoningOption{Type: strings.ToLower(strings.TrimSpace(option.Type)), Values: values})
	}
	var serviceTiers []string
	// Read only the protocol value Relay already routes and prices. Never
	// execute arbitrary experimental provider body patches from a catalog.
	for _, mode := range model.Experimental.Modes {
		if mode.Provider.Body.ServiceTier == "priority" {
			serviceTiers = []string{"priority"}
			break
		}
	}
	return Capability{
		ID:               id,
		Name:             strings.TrimSpace(model.Name),
		Description:      strings.TrimSpace(model.Description),
		Provider:         strings.TrimSpace(providerID),
		Source:           SourceCatalog,
		Context:          model.Limit.Context,
		MaxOutput:        model.Limit.Output,
		MaxInput:         model.Limit.Input,
		ToolCall:         model.ToolCall,
		StructuredOutput: model.StructuredOutput,
		Temperature:      model.Temperature,
		Reasoning:        model.Reasoning,
		ReasoningOptions: options,
		InputModalities:  append([]string(nil), model.Modalities.Input...),
		OutputModalities: append([]string(nil), model.Modalities.Output...),
		ServiceTiers:     serviceTiers,
	}
}

func preferCapability(candidate, current Capability) bool {
	if candidateRank, currentRank := capabilitySourceRank(candidate.Source), capabilitySourceRank(current.Source); candidateRank != currentRank {
		return candidateRank < currentRank
	}
	candidateRank, currentRank := capabilityProviderRank(candidate.Provider), capabilityProviderRank(current.Provider)
	if candidateRank != currentRank {
		return candidateRank < currentRank
	}
	candidateDirect := catalogProviderMatchesModel(candidate.Provider, candidate.ID)
	currentDirect := catalogProviderMatchesModel(current.Provider, current.ID)
	if candidateDirect != currentDirect {
		return candidateDirect
	}
	if candidate.Provider != current.Provider {
		return candidate.Provider < current.Provider
	}
	return candidate.ID < current.ID
}

func capabilitySourceRank(source string) int {
	if strings.EqualFold(strings.TrimSpace(source), SourceAdmin) {
		return -1
	}
	return 0
}

func capabilityProviderRank(provider string) int {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai", "xai", "deepseek", "moonshotai":
		return 0
	case "moonshotai-cn":
		return 1
	default:
		return 10
	}
}

func splitSourceModelID(value string) (string, string) {
	value = strings.TrimSpace(value)
	if provider, model, ok := strings.Cut(value, "/"); ok {
		return strings.TrimSpace(provider), strings.TrimSpace(model)
	}
	return "", value
}

func bareModelID(value string) string {
	value = strings.TrimSpace(value)
	if slash := strings.LastIndex(value, "/"); slash >= 0 {
		return strings.TrimSpace(value[slash+1:])
	}
	return value
}

// CapabilitySnapshot persists facts independently of whether a model has a
// usable price. It shares the existing PostgreSQL catalog transaction.
type CapabilitySnapshot struct {
	Version string       `json:"version"`
	Items   []Capability `json:"items"`
}
