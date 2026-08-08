package dataplane

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
)

type ModelRoute struct {
	Public   string `json:"public" yaml:"public"`
	Upstream string `json:"upstream" yaml:"upstream"`
	Image    bool   `json:"image,omitempty" yaml:"image,omitempty"`
}

// Credential is an immutable, decrypted runtime snapshot. It is never
// serialized by handlers; the database stores the source document encrypted.
type Credential struct {
	ID           string
	Name         string
	Provider     string
	Endpoint     *url.URL
	ProxyURL     string
	AccessToken  string
	APIKey       string
	AccountID    string
	ExtraHeaders http.Header
	Models       []ModelRoute
}

func (c Credential) Apply(req *http.Request) error {
	if req == nil {
		return fmt.Errorf("request is nil")
	}
	for key, values := range c.ExtraHeaders {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	switch strings.ToLower(c.Provider) {
	case "codex":
		if c.AccessToken == "" {
			return fmt.Errorf("codex credential %q has no access token", c.ID)
		}
		req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		if c.AccountID != "" {
			req.Header.Set("ChatGPT-Account-ID", c.AccountID)
		}
		if req.Header.Get("User-Agent") == "" {
			req.Header.Set("User-Agent", "codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)")
		}
		if req.Header.Get("Originator") == "" {
			req.Header.Set("Originator", "codex-tui")
		}
	case "xai", "grok":
		if c.AccessToken == "" {
			return fmt.Errorf("xai credential %q has no access token", c.ID)
		}
		req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		req.Header.Set("X-XAI-Token-Auth", "xai-grok-cli")
		req.Header.Set("X-Grok-Client-Version", "0.2.120")
		req.Header.Set("X-Grok-Client-Identifier", "grok-shell")
		req.Header.Set("X-AuthenticateResponse", "authenticate-response")
		req.Header.Set("User-Agent", "xai-grok-workspace/0.2.120")
	case "claude", "anthropic":
		if c.APIKey != "" {
			req.Header.Set("X-API-Key", c.APIKey)
		} else if c.AccessToken != "" {
			req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		} else {
			return fmt.Errorf("claude credential %q has no token", c.ID)
		}
		if req.Header.Get("Anthropic-Version") == "" {
			req.Header.Set("Anthropic-Version", "2023-06-01")
		}
	default:
		key := c.APIKey
		if key == "" {
			key = c.AccessToken
		}
		if key == "" {
			return fmt.Errorf("credential %q has no API key", c.ID)
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return nil
}

type catalogSnapshot struct {
	byID    map[string]Credential
	byModel map[string][]Credential
}

type CredentialCatalog struct {
	snapshot atomic.Pointer[catalogSnapshot]
	next     atomic.Uint64
}

func NewCredentialCatalog() *CredentialCatalog {
	catalog := &CredentialCatalog{}
	catalog.snapshot.Store(&catalogSnapshot{byID: map[string]Credential{}, byModel: map[string][]Credential{}})
	return catalog
}

func (c *CredentialCatalog) Replace(credentials []Credential) error {
	next := &catalogSnapshot{byID: make(map[string]Credential, len(credentials)), byModel: make(map[string][]Credential)}
	for _, credential := range credentials {
		credential.ID = strings.TrimSpace(credential.ID)
		credential.Provider = strings.ToLower(strings.TrimSpace(credential.Provider))
		if credential.ID == "" || credential.Provider == "" || credential.Endpoint == nil || credential.Endpoint.Scheme == "" || credential.Endpoint.Host == "" {
			return fmt.Errorf("credential requires id, provider and absolute endpoint")
		}
		if _, exists := next.byID[credential.ID]; exists {
			return fmt.Errorf("duplicate credential %q", credential.ID)
		}
		credential.Endpoint = cloneURL(credential.Endpoint)
		credential.ExtraHeaders = credential.ExtraHeaders.Clone()
		credential.Models = append([]ModelRoute(nil), credential.Models...)
		next.byID[credential.ID] = credential
		for _, model := range credential.Models {
			public := strings.ToLower(strings.TrimSpace(model.Public))
			if public != "" {
				next.byModel[public] = append(next.byModel[public], credential)
			}
		}
	}
	c.snapshot.Store(next)
	return nil
}

func (c *CredentialCatalog) Resolve(explicitID, requestedModel string) (Credential, string, error) {
	snapshot := c.snapshot.Load()
	if snapshot == nil {
		return Credential{}, "", fmt.Errorf("credential catalog is unavailable")
	}
	if id := strings.TrimSpace(explicitID); id != "" {
		credential, ok := snapshot.byID[id]
		if !ok {
			return Credential{}, "", fmt.Errorf("credential %q not found", id)
		}
		return credential, upstreamModel(credential, requestedModel), nil
	}
	candidates := snapshot.byModel[strings.ToLower(strings.TrimSpace(requestedModel))]
	if len(candidates) == 0 {
		return Credential{}, "", fmt.Errorf("no credential serves model %q", requestedModel)
	}
	credential := candidates[(c.next.Add(1)-1)%uint64(len(candidates))]
	return credential, upstreamModel(credential, requestedModel), nil
}

func (c *CredentialCatalog) Models() []string {
	snapshot := c.snapshot.Load()
	if snapshot == nil {
		return nil
	}
	models := make([]string, 0, len(snapshot.byModel))
	for model := range snapshot.byModel {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

func (c *CredentialCatalog) Len() int {
	snapshot := c.snapshot.Load()
	if snapshot == nil {
		return 0
	}
	return len(snapshot.byID)
}

func (c *CredentialCatalog) Plan(path, explicitID, requestedModel string, stream bool) (RoutePlan, Credential, error) {
	inbound, err := DetectProtocol(path)
	if err != nil {
		return RoutePlan{}, Credential{}, err
	}
	credential, model, err := c.Resolve(explicitID, requestedModel)
	if err != nil {
		return RoutePlan{}, Credential{}, err
	}
	upstream, err := ProviderProtocol(credential.Provider)
	if err != nil {
		return RoutePlan{}, Credential{}, err
	}
	plan := RoutePlan{
		Provider: credential.Provider, CredentialID: credential.ID, Model: model,
		Endpoint: cloneURL(credential.Endpoint), Inbound: inbound, Upstream: upstream, Stream: stream,
	}
	return plan, credential, plan.Validate()
}

func upstreamModel(credential Credential, requested string) string {
	for _, model := range credential.Models {
		if strings.EqualFold(strings.TrimSpace(model.Public), strings.TrimSpace(requested)) && strings.TrimSpace(model.Upstream) != "" {
			return strings.TrimSpace(model.Upstream)
		}
	}
	return requested
}

func cloneURL(value *url.URL) *url.URL {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
