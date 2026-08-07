package dataplane

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
)

type credentialDocument struct {
	AccessToken string            `json:"access_token"`
	APIKey      string            `json:"api_key"`
	AccountID   string            `json:"account_id"`
	BaseURL     string            `json:"base_url"`
	ProxyURL    string            `json:"proxy_url"`
	RelayProxy  string            `json:"_relay_proxy_url"`
	Headers     map[string]string `json:"headers"`
	ModelRoutes []ModelRoute      `json:"model_routes"`
}

func CompileCredential(id, name, provider string, models []string, document []byte) (Credential, error) {
	var value credentialDocument
	if err := json.Unmarshal(document, &value); err != nil {
		return Credential{}, fmt.Errorf("decode credential %q: %w", id, err)
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	endpoint, err := providerEndpoint(provider, value.BaseURL)
	if err != nil {
		return Credential{}, fmt.Errorf("credential %q: %w", id, err)
	}
	routes := append([]ModelRoute(nil), value.ModelRoutes...)
	if len(routes) == 0 {
		for _, model := range models {
			if model = strings.TrimSpace(model); model != "" {
				routes = append(routes, ModelRoute{Public: model, Upstream: model})
			}
		}
	}
	headers := make(http.Header, len(value.Headers))
	for key, headerValue := range value.Headers {
		if strings.TrimSpace(key) != "" {
			headers.Set(key, headerValue)
		}
	}
	proxyURL := value.ProxyURL
	if proxyURL == "" {
		proxyURL = value.RelayProxy
	}
	return Credential{
		ID: id, Name: name, Provider: provider, Endpoint: endpoint, ProxyURL: proxyURL,
		AccessToken: value.AccessToken, APIKey: value.APIKey, AccountID: value.AccountID,
		ExtraHeaders: headers, Models: routes,
	}, nil
}

func providerEndpoint(provider, rawBaseURL string) (*url.URL, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(rawBaseURL), "/")
	suffix := ""
	switch provider {
	case "codex":
		if baseURL == "" {
			baseURL = "https://chatgpt.com/backend-api/codex"
		}
		suffix = "responses"
	case "xai", "grok":
		if baseURL == "" {
			baseURL = "https://cli-chat-proxy.grok.com/v1"
		}
		suffix = "responses"
	case "claude", "anthropic":
		if baseURL == "" {
			baseURL = "https://api.anthropic.com"
		}
		suffix = "v1/messages"
	case "openai", "openai-compatible", "kimi":
		if baseURL == "" {
			baseURL = "https://api.openai.com/v1"
		}
		suffix = "chat/completions"
	default:
		return nil, fmt.Errorf("unsupported provider %q", provider)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid base URL")
	}
	if !strings.HasSuffix(strings.ToLower(parsed.Path), "/"+strings.ToLower(suffix)) {
		parsed.Path = path.Join(parsed.Path, suffix)
	}
	return parsed, nil
}
