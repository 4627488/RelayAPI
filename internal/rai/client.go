package rai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strings"
	"time"
)

type Discovery struct {
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`
	APIBase         string   `json:"api_base"`
	Models          string   `json:"models"`
	Health          string   `json:"health"`
	Session         string   `json:"session"`
	Authorization   string   `json:"authorization"`
	Token           string   `json:"token"`
	Authorize       string   `json:"authorize"`
	Install         string   `json:"install"`
	Download        string   `json:"download"`
	RAIVersion      string   `json:"rai_version"`
	Adapters        []string `json:"adapters"`
	ContractVersion string   `json:"contract_version"`
	MinRAIVersion   string   `json:"min_rai_version"`
}

type Authorization struct {
	UserCode              string
	DeviceVerificationURI string
	ID                    string
	VerificationURI       string
	ExpiresIn             int
	Interval              int
}

type TokenResult struct {
	AccessToken  string
	RefreshToken string
	Purpose      string
	ExpiresIn    int
}

type tokenError struct {
	Code    string
	Message string
}

type Session struct {
	ContractVersion string   `json:"contract_version"`
	Name            string   `json:"name"`
	APIBase         string   `json:"api_base"`
	Models          []string `json:"models"`
	DefaultModel    string   `json:"default_model"`
	Adapters        []string `json:"adapters"`
}

type Gateway struct {
	HTTP    *http.Client
	Timeout time.Duration
}

func NewGateway() Gateway {
	return Gateway{
		HTTP:    &http.Client{Timeout: 15 * time.Second},
		Timeout: 15 * time.Second,
	}
}

func (g Gateway) Discover(ctx context.Context, server string) (Discovery, error) {
	server, err := normalizeServerURL(server)
	if err != nil {
		return Discovery{}, err
	}
	discovery, err := g.getDiscovery(ctx, server+"/.well-known/rai.json")
	if err == nil {
		if strings.TrimSpace(discovery.APIBase) == "" {
			discovery.APIBase = server
		}
		discovery.APIBase, err = normalizeServerURL(discovery.APIBase)
		if err != nil {
			return Discovery{}, err
		}
		return discovery, nil
	}
	return Discovery{
		Name:            "RelayAPI",
		Kind:            configKind,
		APIBase:         server,
		Models:          "/v1/models",
		Health:          "/healthz",
		Session:         "/api/rai/session",
		Authorization:   "/api/rai/authorizations",
		Token:           "/api/rai/token",
		Authorize:       "/rai/authorize",
		Install:         "/rai/install.sh",
		Download:        "/rai/download",
		Adapters:        []string{"claude", "codex", "grok", "hermes", "opencode", "pi", "prime-agent"},
		ContractVersion: contractVersion,
		MinRAIVersion:   minRAIVersion,
	}, nil
}

func (g Gateway) getDiscovery(ctx context.Context, rawURL string) (Discovery, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Discovery{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return Discovery{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Discovery{}, fmt.Errorf("discovery %s: %s", resp.Status, redact(string(body)))
	}
	var discovery Discovery
	if err := json.Unmarshal(body, &discovery); err != nil {
		return Discovery{}, fmt.Errorf("parse discovery document: %w", err)
	}
	return discovery, nil
}

func (g Gateway) Session(ctx context.Context, apiBase, apiKey string) (Session, error) {
	if strings.HasPrefix(apiKey, "rai_at_") {
		g = g.managementGateway()
	}
	apiBase, err := normalizeServerURL(apiBase)
	if err != nil {
		return Session{}, err
	}
	session, err := g.getJSONSession(ctx, apiBase+"/api/rai/session", apiKey)
	if err == errOAuthLoginRequired {
		return Session{}, err
	}
	if err == nil && len(session.Models) > 0 {
		if session.APIBase == "" || strings.HasPrefix(apiKey, "rai_at_") {
			session.APIBase = apiBase
		}
		return session, nil
	}
	models, modelsErr := g.ListModels(ctx, apiBase, apiKey)
	if modelsErr != nil {
		if err != nil {
			return Session{}, modelsErr
		}
		return Session{}, err
	}
	defaultModel := SelectDefaultModel(models, DefaultModelCandidates())
	return Session{
		ContractVersion: contractVersion,
		Name:            "RelayAPI",
		APIBase:         apiBase,
		Models:          models,
		DefaultModel:    defaultModel,
		Adapters:        []string{"codex", "opencode"},
	}, nil
}

func (g Gateway) getJSONSession(ctx context.Context, rawURL, apiKey string) (Session, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return Session{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized && strings.HasPrefix(apiKey, "rai_at_") {
		return Session{}, errOAuthLoginRequired
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return Session{}, fmt.Errorf("session %s: %s", resp.Status, redact(string(body)))
	}
	var session Session
	if err := json.Unmarshal(body, &session); err != nil {
		return Session{}, fmt.Errorf("parse session: %w", err)
	}
	return session, nil
}

func (g Gateway) ListModels(ctx context.Context, apiBase, apiKey string) ([]string, error) {
	if strings.HasPrefix(apiKey, "rai_at_") {
		g = g.managementGateway()
	}
	apiBase, err := normalizeServerURL(apiBase)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized && strings.HasPrefix(apiKey, "rai_at_") {
		return nil, errOAuthLoginRequired
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models %s: %s", resp.Status, redact(string(body)))
	}
	return parseModelIDs(body)
}

func (g Gateway) StartAuthorization(ctx context.Context, apiBase, deviceName, challenge string, purpose ...string) (Authorization, error) {
	apiBase, err := normalizeServerURL(apiBase)
	if err != nil {
		return Authorization{}, err
	}
	input := map[string]string{
		"device_name":           deviceName,
		"device_os":             runtime.GOOS,
		"device_arch":           runtime.GOARCH,
		"rai_version":           Version,
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
	}
	if len(purpose) > 0 {
		input["purpose"] = purpose[0]
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return Authorization{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBase+"/api/rai/authorizations", strings.NewReader(string(payload)))
	if err != nil {
		return Authorization{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return Authorization{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return Authorization{}, fmt.Errorf("authorization %s: %s", resp.Status, redact(string(body)))
	}
	var document struct {
		AuthorizationID       string `json:"authorization_id"`
		UserCode              string `json:"user_code"`
		DeviceVerificationURI string `json:"device_verification_uri"`
		VerificationURI       string `json:"verification_uri"`
		ExpiresIn             int    `json:"expires_in"`
		Interval              int    `json:"interval"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return Authorization{}, fmt.Errorf("parse authorization: %w", err)
	}
	if document.AuthorizationID == "" || document.VerificationURI == "" {
		return Authorization{}, fmt.Errorf("authorization response missing verification_uri")
	}
	if document.Interval < 1 {
		document.Interval = 3
	}
	return Authorization{
		UserCode:              document.UserCode,
		DeviceVerificationURI: document.DeviceVerificationURI,
		ID:                    document.AuthorizationID,
		VerificationURI:       document.VerificationURI,
		ExpiresIn:             document.ExpiresIn,
		Interval:              document.Interval,
	}, nil
}

func (g Gateway) ExchangeToken(ctx context.Context, apiBase, authorizationID, verifier string, purpose ...string) (TokenResult, error) {
	apiBase, err := normalizeServerURL(apiBase)
	if err != nil {
		return TokenResult{}, err
	}
	payload, err := json.Marshal(map[string]string{
		"authorization_id": authorizationID,
		"code_verifier":    verifier,
	})
	if err != nil {
		return TokenResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBase+"/api/rai/token", strings.NewReader(string(payload)))
	if err != nil {
		return TokenResult{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return TokenResult{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return TokenResult{}, tokenResponseError(body)
	}
	var document struct {
		AccessToken  string `json:"access_token"`
		Purpose      string `json:"purpose"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		APIKey       string `json:"api_key"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return TokenResult{}, fmt.Errorf("parse token: %w", err)
	}
	wanted := "inference"
	if len(purpose) > 0 {
		wanted = purpose[0]
	}
	if document.Purpose != wanted || !strings.HasPrefix(document.AccessToken, "rai_at_") || !strings.HasPrefix(document.RefreshToken, "rai_rt_") || document.ExpiresIn <= 0 || document.ExpiresIn > 900 || document.APIKey != "" {
		return TokenResult{}, fmt.Errorf("server did not grant renewable %s authorization; update the server or use an explicitly supplied API Key", wanted)
	}
	return TokenResult{AccessToken: document.AccessToken, RefreshToken: document.RefreshToken, Purpose: document.Purpose, ExpiresIn: document.ExpiresIn}, nil
}

func tokenResponseError(body []byte) error {
	var document struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &document) == nil && document.Error.Code != "" {
		return tokenError{Code: document.Error.Code, Message: document.Error.Message}
	}
	return fmt.Errorf("token %s", redact(string(body)))
}

func (e tokenError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

func parseModelIDs(payload []byte) ([]string, error) {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, fmt.Errorf("parse model catalog: %w", err)
	}
	seen := map[string]struct{}{}
	var models []string
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	for _, key := range []string{"data", "models"} {
		raw, ok := document[key].([]any)
		if !ok {
			continue
		}
		for _, item := range raw {
			row, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if visibility, _ := row["visibility"].(string); strings.EqualFold(visibility, "hide") {
				continue
			}
			for _, field := range []string{"id", "slug", "name"} {
				if value, _ := row[field].(string); value != "" {
					add(value)
					break
				}
			}
		}
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("model catalog contained no visible models")
	}
	sort.Strings(models)
	return models, nil
}

func resolveURL(base, ref string) string {
	if ref == "" {
		return base
	}
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	joined, err := url.JoinPath(base, ref)
	if err != nil {
		return strings.TrimRight(base, "/") + "/" + strings.TrimPrefix(ref, "/")
	}
	return joined
}
