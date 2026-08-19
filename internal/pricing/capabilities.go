package pricing

import (
	"encoding/json"
	"strings"
)

// Capability is the models.dev fact sheet Relay uses for Codex ModelInfo:
// context, modalities, and advertised reasoning controls. It is not a price.
type Capability struct {
	ID               string
	Name             string
	Provider         string
	Source           string
	Context          int
	MaxOutput        int
	Reasoning        bool
	ReasoningOptions []ReasoningOption
	DefaultLevel     string
	InputModalities  []string
	PreferWebSockets *bool
}

type ReasoningOption struct {
	Type   string
	Values []string
}

type CapabilityIndex struct {
	version string
	byKey   map[string]Capability
}

func NewCapabilityIndex(version string, capabilities []Capability) *CapabilityIndex {
	index := &CapabilityIndex{version: strings.TrimSpace(version), byKey: make(map[string]Capability, len(capabilities)*3)}
	for _, capability := range capabilities {
		index.add(capability)
	}
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
	if idx == nil || len(idx.byKey) == 0 {
		return Capability{}, false
	}
	for _, candidate := range modelCandidates(slug) {
		if capability, ok := idx.byKey[strings.ToLower(strings.TrimSpace(candidate))]; ok {
			return capability, true
		}
	}
	return Capability{}, false
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
	keys := []string{capability.ID, capability.Provider + "/" + bareModelID(capability.ID)}
	if bare := bareModelID(capability.ID); bare != "" {
		keys = append(keys, bare)
	}
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		if current, exists := idx.byKey[key]; exists && !preferCapability(capability, current) {
			continue
		}
		idx.byKey[key] = capability
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
	return Capability{
		ID:               id,
		Name:             strings.TrimSpace(model.Name),
		Provider:         strings.TrimSpace(providerID),
		Source:           SourceCatalog,
		Context:          model.Limit.Context,
		MaxOutput:        model.Limit.Output,
		Reasoning:        model.Reasoning,
		ReasoningOptions: options,
		InputModalities:  append([]string(nil), model.Modalities.Input...),
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
