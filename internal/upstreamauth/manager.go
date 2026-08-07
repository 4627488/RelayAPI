package upstreamauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/dataplane"
	"github.com/4627488/RelayAPI/internal/store"
	"golang.org/x/sync/singleflight"
)

const (
	codexTokenEndpoint = "https://auth.openai.com/oauth/token"
	codexClientID      = "app_EMoamEEZ73f0CkXaXp7hrann"
	xaiClientID        = "b1a00492-073a-47ea-816f-4c329264a828"
)

type Manager struct {
	store      store.Store
	catalog    *dataplane.CredentialCatalog
	transports *dataplane.TransportPool
	group      singleflight.Group
}

func NewManager(dataStore store.Store, catalog *dataplane.CredentialCatalog, transports *dataplane.TransportPool) *Manager {
	return &Manager{store: dataStore, catalog: catalog, transports: transports}
}

func (m *Manager) Reload(ctx context.Context) error {
	rows, err := m.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	now := time.Now()
	compiled := make([]dataplane.Credential, 0, len(rows))
	for _, row := range rows {
		if !row.Enabled || row.ExpiresAt != nil && !row.ExpiresAt.After(now) {
			continue
		}
		credential, err := dataplane.CompileCredential(row.ID, row.Name, row.Provider, row.Models, row.Document)
		if err != nil {
			return err
		}
		compiled = append(compiled, credential)
	}
	return m.catalog.Replace(compiled)
}

func (m *Manager) RefreshDue(ctx context.Context, lead time.Duration) error {
	rows, err := m.store.ListUpstreamCredentials(ctx)
	if err != nil {
		return err
	}
	var refreshErrors []error
	for _, row := range rows {
		if !row.Enabled || !refreshDue(row.Provider, row.Document, lead) {
			continue
		}
		if err := m.Refresh(ctx, row.ID); err != nil {
			refreshErrors = append(refreshErrors, err)
		}
	}
	return errors.Join(refreshErrors...)
}

func (m *Manager) Refresh(ctx context.Context, id string) error {
	_, err, _ := m.group.Do(strings.TrimSpace(id), func() (any, error) {
		refreshCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		row, err := m.store.GetUpstreamCredential(refreshCtx, id)
		if err != nil {
			return nil, err
		}
		updated, err := m.refreshDocument(refreshCtx, row)
		if err != nil {
			return nil, err
		}
		_, err = m.store.UpsertUpstreamCredential(refreshCtx, store.UpstreamCredentialInput{
			ID: row.ID, Name: row.Name, Provider: row.Provider, Enabled: row.Enabled,
			Models: row.Models, Document: updated, Source: row.Source, ExpiresAt: row.ExpiresAt,
		})
		if err != nil {
			return nil, err
		}
		return nil, m.Reload(refreshCtx)
	})
	return err
}

func (m *Manager) refreshDocument(ctx context.Context, row store.UpstreamCredentialSnapshot) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(row.Document, &document); err != nil {
		return nil, err
	}
	refreshToken := stringField(document, "refresh_token")
	if refreshToken == "" {
		return nil, fmt.Errorf("credential %q has no refresh token", row.ID)
	}
	endpoint := ""
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	switch strings.ToLower(row.Provider) {
	case "codex":
		endpoint = codexTokenEndpoint
		form.Set("client_id", codexClientID)
		form.Set("scope", "openid profile email")
	case "xai", "grok":
		endpoint = stringField(document, "token_endpoint")
		if endpoint == "" {
			return nil, fmt.Errorf("credential %q has no xAI token endpoint", row.ID)
		}
		form.Set("client_id", xaiClientID)
	default:
		return nil, fmt.Errorf("provider %q does not support OAuth refresh", row.Provider)
	}
	if err := validateTokenEndpoint(row.Provider, endpoint); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	proxyURL := stringField(document, "proxy_url")
	if proxyURL == "" {
		proxyURL = stringField(document, "_relay_proxy_url")
	}
	client, err := m.transports.Client(proxyURL)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("refresh credential %q: %w", row.ID, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		var oauthError struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(payload, &oauthError)
		return nil, fmt.Errorf("refresh credential %q returned %d (%s)", row.ID, response.StatusCode, oauthError.Error)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(payload, &token); err != nil || strings.TrimSpace(token.AccessToken) == "" {
		return nil, fmt.Errorf("refresh credential %q returned an invalid token document", row.ID)
	}
	document["access_token"] = token.AccessToken
	if token.RefreshToken != "" {
		document["refresh_token"] = token.RefreshToken
	}
	if token.IDToken != "" {
		document["id_token"] = token.IDToken
	}
	if token.TokenType != "" {
		document["token_type"] = token.TokenType
	}
	if token.ExpiresIn > 0 {
		document["expires_in"] = token.ExpiresIn
		document["expired"] = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).Format(time.RFC3339)
	}
	document["last_refresh"] = time.Now().Format(time.RFC3339)
	return json.Marshal(document)
}

func refreshDue(provider string, document []byte, lead time.Duration) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codex", "xai", "grok":
	default:
		return false
	}
	var value map[string]any
	if json.Unmarshal(document, &value) != nil || stringField(value, "refresh_token") == "" {
		return false
	}
	expires, err := time.Parse(time.RFC3339, stringField(value, "expired"))
	return err == nil && !expires.After(time.Now().Add(lead))
}

func validateTokenEndpoint(provider, endpoint string) error {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return fmt.Errorf("invalid OAuth token endpoint")
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.EqualFold(provider, "codex") && host != "auth.openai.com" {
		return fmt.Errorf("unexpected Codex token endpoint")
	}
	if (strings.EqualFold(provider, "xai") || strings.EqualFold(provider, "grok")) && host != "auth.x.ai" && !strings.HasSuffix(host, ".auth.x.ai") {
		return fmt.Errorf("unexpected xAI token endpoint")
	}
	return nil
}

func stringField(document map[string]any, key string) string {
	value, _ := document[key].(string)
	return strings.TrimSpace(value)
}
