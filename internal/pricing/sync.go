package pricing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

const ModelsDevURL = "https://models.dev/api.json"

type modelsDevProvider struct {
	ID     string                    `json:"id"`
	Name   string                    `json:"name"`
	Models map[string]modelsDevModel `json:"models"`
}
type modelsDevModel struct {
	ID               string                  `json:"id"`
	Name             string                  `json:"name"`
	Status           string                  `json:"status"`
	Reasoning        bool                    `json:"reasoning"`
	ReasoningOptions []modelsDevReasoningOpt `json:"reasoning_options"`
	Limit            modelsDevLimit          `json:"limit"`
	Modalities       modelsDevModalities     `json:"modalities"`
	Cost             modelsDevCost           `json:"cost"`
}
type modelsDevReasoningOpt struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
}
type modelsDevLimit struct {
	Context int `json:"context"`
	Output  int `json:"output"`
}
type modelsDevModalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}
type modelsDevCost struct {
	Input      *float64 `json:"input"`
	Output     *float64 `json:"output"`
	CacheRead  *float64 `json:"cache_read"`
	CacheWrite *float64 `json:"cache_write"`
}

type CatalogEntry struct {
	Price
	SourceModelID string `json:"source_model_id"`
	RawJSON       string `json:"-"`
}

type modelsDevCatalogCandidate struct {
	entry      CatalogEntry
	providerID string
}

type SyncResult struct {
	Source       string         `json:"source"`
	Version      string         `json:"version"`
	URL          string         `json:"url"`
	Entries      []CatalogEntry `json:"entries"`
	Capabilities []Capability   `json:"capabilities,omitempty"`
}

func FetchModelsDev(ctx context.Context, client *http.Client, rawURL string) (SyncResult, error) {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	if strings.TrimSpace(rawURL) == "" {
		rawURL = ModelsDevURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return SyncResult{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return SyncResult{}, fmt.Errorf("fetch models.dev: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return SyncResult{}, fmt.Errorf("fetch models.dev: %s", response.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 12<<20))
	if err != nil {
		return SyncResult{}, err
	}
	var providers map[string]modelsDevProvider
	if err := json.Unmarshal(raw, &providers); err != nil {
		return SyncResult{}, fmt.Errorf("decode models.dev: %w", err)
	}
	hash := sha256.Sum256(raw)
	version := "sha256:" + hex.EncodeToString(hash[:])
	candidates := make(map[string]modelsDevCatalogCandidate, 1024)
	capabilityCandidates := make(map[string]Capability, 1024)
	for providerKey, provider := range providers {
		providerID := strings.TrimSpace(provider.ID)
		if providerID == "" {
			providerID = strings.TrimSpace(providerKey)
		}
		for modelKey, model := range provider.Models {
			if strings.EqualFold(model.Status, "deprecated") {
				continue
			}
			modelID := strings.TrimSpace(model.ID)
			if modelID == "" {
				modelID = strings.TrimSpace(modelKey)
			}
			if modelID == "" {
				continue
			}
			capability := capabilityFromModelsDev(providerID, modelID, model)
			capKey := strings.ToLower(capability.ID)
			if current, ok := capabilityCandidates[capKey]; !ok || preferCapability(capability, current) {
				capabilityCandidates[capKey] = capability
			}
			if model.Cost.Input == nil || model.Cost.Output == nil || !validCatalogCost(*model.Cost.Input) || !validCatalogCost(*model.Cost.Output) {
				continue
			}
			cacheRead := *model.Cost.Input
			if model.Cost.CacheRead != nil && validCatalogCost(*model.Cost.CacheRead) {
				cacheRead = *model.Cost.CacheRead
			}
			cacheWrite := *model.Cost.Input
			if model.Cost.CacheWrite != nil && validCatalogCost(*model.Cost.CacheWrite) {
				cacheWrite = *model.Cost.CacheWrite
			}
			rawModel, _ := json.Marshal(model)
			name := modelID
			if providerID != "" && !strings.Contains(name, "/") {
				name = providerID + "/" + name
			}
			candidate := modelsDevCatalogCandidate{
				providerID: providerID,
				entry: CatalogEntry{
					Price: Price{
						Model: name, InputNanoUSDPerToken: perMillionToNano(*model.Cost.Input),
						OutputNanoUSDPerToken:      perMillionToNano(*model.Cost.Output),
						CachedInputNanoUSDPerToken: perMillionToNano(cacheRead),
						CacheWriteNanoUSDPerToken:  perMillionToNano(cacheWrite),
						ReasoningNanoUSDPerToken:   perMillionToNano(*model.Cost.Output),
						Source:                     SourceCatalog, Version: version, PriceMultiplier: 1,
					},
					SourceModelID: providerID + "/" + modelID, RawJSON: string(rawModel),
				},
			}
			// Aggregators commonly expose already-qualified IDs such as
			// "anthropic/claude-*". Without deduplication those collide with
			// the direct Anthropic provider (and with other aggregators) when
			// the catalog is inserted using Model as its primary key.
			key := strings.ToLower(name)
			if current, ok := candidates[key]; !ok || preferCatalogCandidate(candidate, current) {
				candidates[key] = candidate
			}
		}
	}
	entries := make([]CatalogEntry, 0, len(candidates))
	for _, candidate := range candidates {
		entries = append(entries, candidate.entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Model < entries[j].Model })
	if len(entries) < 10 {
		return SyncResult{}, fmt.Errorf("models.dev catalog contains only %d priced models", len(entries))
	}
	capabilities := make([]Capability, 0, len(capabilityCandidates))
	for _, capability := range capabilityCandidates {
		capabilities = append(capabilities, capability)
	}
	sort.Slice(capabilities, func(i, j int) bool { return capabilities[i].ID < capabilities[j].ID })
	return SyncResult{Source: SourceCatalog, Version: version, URL: rawURL, Entries: entries, Capabilities: capabilities}, nil
}

func preferCatalogCandidate(candidate, current modelsDevCatalogCandidate) bool {
	candidateDirect := catalogProviderMatchesModel(candidate.providerID, candidate.entry.Model)
	currentDirect := catalogProviderMatchesModel(current.providerID, current.entry.Model)
	if candidateDirect != currentDirect {
		return candidateDirect
	}
	if candidate.providerID != current.providerID {
		return candidate.providerID < current.providerID
	}
	if candidate.entry.SourceModelID != current.entry.SourceModelID {
		return candidate.entry.SourceModelID < current.entry.SourceModelID
	}
	return candidate.entry.RawJSON < current.entry.RawJSON
}

func catalogProviderMatchesModel(providerID, model string) bool {
	prefix, _, ok := strings.Cut(model, "/")
	return ok && strings.EqualFold(strings.TrimSpace(providerID), strings.TrimSpace(prefix))
}

func validCatalogCost(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func perMillionToNano(value float64) int64 {
	// USD / 1M tokens * 1e9 nanoUSD / USD = value * 1000 nanoUSD/token.
	return int64(math.Round(value * 1000))
}
