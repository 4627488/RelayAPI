package cpaimport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
	"gopkg.in/yaml.v3"
)

type Report struct {
	Imported       int
	Skipped        int
	GlobalProxyURL string
}

type Config struct {
	ProxyURL            string                `yaml:"proxy-url"`
	OpenAICompatibility []openAICompatibility `yaml:"openai-compatibility"`
}

type openAICompatibility struct {
	Name          string           `yaml:"name"`
	BaseURL       string           `yaml:"base-url"`
	APIKeyEntries []openAIKeyEntry `yaml:"api-key-entries"`
	Models        []openAIModel    `yaml:"models"`
}

type openAIKeyEntry struct {
	APIKey   string `yaml:"api-key"`
	ProxyURL string `yaml:"proxy-url"`
}

type openAIModel struct {
	Name  string `yaml:"name"`
	Alias string `yaml:"alias"`
	Image bool   `yaml:"image,omitempty"`
}

type modelRoute struct {
	Public   string `json:"public"`
	Upstream string `json:"upstream"`
	Image    bool   `json:"image,omitempty"`
}

func Import(ctx context.Context, dataStore store.Store, authDir, configPath string, overwrite bool) (Report, error) {
	existing, err := dataStore.ListUpstreamCredentials(ctx)
	if err != nil {
		return Report{}, err
	}
	existingByID := make(map[string]store.UpstreamCredentialSnapshot, len(existing))
	for _, item := range existing {
		existingByID[item.ID] = item
	}
	parents, err := dataStore.ListParentSubscriptions(ctx)
	if err != nil {
		return Report{}, err
	}
	modelsByID := make(map[string][]string, len(parents))
	for _, parent := range parents {
		modelsByID[parent.CPAAuthID] = append([]string(nil), parent.ModelAllowlist...)
		modelsByID[parent.CPAAuthID] = append(modelsByID[parent.CPAAuthID], parent.CPAModelAllowlist...)
	}

	legacyConfig, err := readConfig(configPath)
	if err != nil {
		return Report{}, err
	}
	report := Report{GlobalProxyURL: strings.TrimSpace(legacyConfig.ProxyURL)}
	var entries []os.DirEntry
	if strings.TrimSpace(authDir) != "" {
		entries, err = os.ReadDir(authDir)
		if err != nil && !os.IsNotExist(err) {
			return report, fmt.Errorf("read CPA auth dir: %w", err)
		}
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		payload, err := os.ReadFile(filepath.Join(authDir, entry.Name()))
		if err != nil {
			return report, err
		}
		var document map[string]any
		if err := json.Unmarshal(payload, &document); err != nil {
			return report, fmt.Errorf("decode CPA credential %q: %w", entry.Name(), err)
		}
		provider, _ := document["type"].(string)
		if strings.TrimSpace(provider) == "" {
			return report, fmt.Errorf("CPA credential %q has no type", entry.Name())
		}
		_, alreadyImported := existingByID[entry.Name()]
		delete(document, "_relay_proxy_url")
		if !alreadyImported && credentialProxy(document) == "" && strings.TrimSpace(legacyConfig.ProxyURL) != "" {
			document["proxy_url"] = strings.TrimSpace(legacyConfig.ProxyURL)
		}
		payload, _ = json.Marshal(document)
		enabled := true
		if disabled, ok := document["disabled"].(bool); ok {
			enabled = !disabled
		}
		input := store.UpstreamCredentialInput{ID: entry.Name(), Name: entry.Name(), Provider: provider, Enabled: enabled, Models: unique(modelsByID[entry.Name()]), Document: payload, Source: "cpa-auth-file"}
		changed, err := upsertIfChanged(ctx, dataStore, existingByID, input, overwrite)
		if err != nil {
			return report, err
		}
		if changed {
			report.Imported++
		} else {
			report.Skipped++
		}
	}

	for providerIndex, provider := range legacyConfig.OpenAICompatibility {
		routes := make([]modelRoute, 0, len(provider.Models))
		models := make([]string, 0, len(provider.Models))
		for _, model := range provider.Models {
			public := strings.TrimSpace(model.Alias)
			if public == "" {
				public = strings.TrimSpace(model.Name)
			}
			if public == "" {
				continue
			}
			models = append(models, public)
			routes = append(routes, modelRoute{Public: public, Upstream: strings.TrimSpace(model.Name), Image: model.Image})
		}
		for keyIndex, key := range provider.APIKeyEntries {
			proxyURL := strings.TrimSpace(key.ProxyURL)
			if proxyURL == "" {
				proxyURL = legacyConfig.ProxyURL
			}
			document, _ := json.Marshal(map[string]any{"api_key": key.APIKey, "base_url": provider.BaseURL, "proxy_url": proxyURL, "model_routes": routes})
			id := fmt.Sprintf("openai-compat:%02d:%02d:%s", providerIndex, keyIndex, shortHash(provider.Name+"\x00"+provider.BaseURL))
			input := store.UpstreamCredentialInput{ID: id, Name: provider.Name, Provider: "openai", Enabled: strings.TrimSpace(key.APIKey) != "", Models: models, Document: document, Source: "cpa-config"}
			changed, err := upsertIfChanged(ctx, dataStore, existingByID, input, overwrite)
			if err != nil {
				return report, err
			}
			if changed {
				report.Imported++
			} else {
				report.Skipped++
			}
		}
	}
	return report, nil
}

func credentialProxy(document map[string]any) string {
	if value, ok := document["proxy_url"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return ""
}

func readConfig(path string) (Config, error) {
	if strings.TrimSpace(path) == "" {
		return Config{}, nil
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, nil
		}
		return Config{}, fmt.Errorf("read CPA config: %w", err)
	}
	var config Config
	if err := yaml.Unmarshal(payload, &config); err != nil {
		return Config{}, fmt.Errorf("decode CPA config: %w", err)
	}
	return config, nil
}

func upsertIfChanged(ctx context.Context, dataStore store.Store, existing map[string]store.UpstreamCredentialSnapshot, input store.UpstreamCredentialInput, overwrite bool) (bool, error) {
	if current, ok := existing[input.ID]; ok {
		if !overwrite || current.Provider == strings.ToLower(input.Provider) && current.Enabled == input.Enabled && equalStrings(current.Models, input.Models) && jsonEqual(current.Document, input.Document) {
			return false, nil
		}
	}
	item, err := dataStore.UpsertUpstreamCredential(ctx, input)
	if err == nil {
		existing[input.ID] = item
	}
	return err == nil, err
}

func jsonEqual(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}

func equalStrings(a, b []string) bool {
	return bytes.Equal([]byte(strings.Join(unique(a), "\x00")), []byte(strings.Join(unique(b), "\x00")))
}

func unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:6])
}
