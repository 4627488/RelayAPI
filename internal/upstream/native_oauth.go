package upstream

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
)

const (
	codexClientID     = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexRedirectURI  = "http://localhost:1455/auth/callback"
	codexTokenURL     = "https://auth.openai.com/oauth/token"
	kimiClientID      = "17e5f671-d194-4dfb-9706-5516cb48c098"
	kimiTokenURL      = "https://auth.kimi.com/api/oauth/token"
	xaiClientID       = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiTokenURL       = "https://auth.x.ai/oauth2/token"
	codexRefreshScope = "openid profile email"
)

type oauthManager struct {
	mu       sync.Mutex
	options  Options
	sessions map[string]*oauthRuntimeSession
	closed   bool
	client   *http.Client
}

type oauthRuntimeSession struct {
	state, provider, relaySession, verifier, tokenURL, deviceCode, deviceID string
	status, err                                                             string
	cancel                                                                  context.CancelFunc
}

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func newOAuthManager(options Options) *oauthManager {
	client, err := egress.OutboundHTTPClient(options.ProxyURL, 30*time.Second)
	if err != nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &oauthManager{options: options, sessions: make(map[string]*oauthRuntimeSession), client: client}
}

func (m *oauthManager) applyProxy(proxyURL string) error {
	client, err := egress.OutboundHTTPClient(proxyURL, 30*time.Second)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.options.ProxyURL = proxyURL
	m.client = client
	m.mu.Unlock()
	return nil
}

func (m *oauthManager) httpClient() *http.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.client
}

func (m *oauthManager) start(ctx context.Context, provider, relaySession string) (OAuthStartResult, error) {
	provider = canonicalProvider(provider)
	if provider == "openai-compatibility" || provider == "openai" || provider == "" {
		return OAuthStartResult{}, fmt.Errorf("OAuth is not supported for provider %q", provider)
	}
	state, err := randomURLToken(32)
	if err != nil {
		return OAuthStartResult{}, err
	}
	session := &oauthRuntimeSession{state: state, provider: provider, relaySession: strings.TrimSpace(relaySession), status: "waiting"}
	if provider == "codex" {
		verifier, randomErr := randomURLToken(64)
		if randomErr != nil {
			return OAuthStartResult{}, randomErr
		}
		session.verifier = verifier
		challenge := base64.RawURLEncoding.EncodeToString(sha256Sum([]byte(verifier)))
		query := url.Values{"client_id": {codexClientID}, "response_type": {"code"}, "redirect_uri": {codexRedirectURI}, "scope": {"openid email profile offline_access"}, "state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "prompt": {"login"}, "id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}}
		m.put(session)
		return OAuthStartResult{Status: "waiting", URL: "https://auth.openai.com/oauth/authorize?" + query.Encode(), State: state, Flow: "callback", ExpiresIn: 1800}, nil
	}
	device, tokenURL, err := m.startDevice(ctx, provider, state)
	if err != nil {
		return OAuthStartResult{}, err
	}
	session.deviceCode, session.tokenURL = device.DeviceCode, tokenURL
	session.deviceID = state
	pollCtx, cancel := context.WithCancel(context.Background())
	session.cancel = cancel
	m.put(session)
	go m.pollDevice(pollCtx, session, device)
	authURL := firstNonEmpty(device.VerificationURIComplete, device.VerificationURI)
	return OAuthStartResult{Status: "waiting", URL: authURL, State: state, Flow: "device", UserCode: device.UserCode, ExpiresIn: device.ExpiresIn}, nil
}

func (m *oauthManager) put(session *oauthRuntimeSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		m.sessions[session.state] = session
	}
}

func (m *oauthManager) status(_ context.Context, state string) (OAuthStatusResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session := m.sessions[strings.TrimSpace(state)]
	if session == nil {
		return OAuthStatusResult{}, fmt.Errorf("OAuth session not found")
	}
	if session.err != "" {
		return OAuthStatusResult{Status: "error", Error: session.err}, nil
	}
	return OAuthStatusResult{Status: session.status}, nil
}

func (m *oauthManager) submitCallback(ctx context.Context, provider, state, redirectURL string) error {
	m.mu.Lock()
	session := m.sessions[strings.TrimSpace(state)]
	m.mu.Unlock()
	if session == nil || session.provider != canonicalProvider(provider) || session.provider != "codex" {
		return fmt.Errorf("OAuth session does not match provider")
	}
	parsed, err := url.Parse(strings.TrimSpace(redirectURL))
	if err != nil {
		return fmt.Errorf("invalid callback URL: %w", err)
	}
	if returnedState := parsed.Query().Get("state"); returnedState != "" && returnedState != state {
		return fmt.Errorf("OAuth callback state does not match")
	}
	if oauthError := parsed.Query().Get("error"); oauthError != "" {
		return fmt.Errorf("OAuth authorization failed: %s", oauthError)
	}
	code := strings.TrimSpace(parsed.Query().Get("code"))
	if code == "" {
		return fmt.Errorf("OAuth callback is missing authorization code")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {codexClientID}, "code": {code}, "redirect_uri": {codexRedirectURI}, "code_verifier": {session.verifier}}
	tokens, err := postOAuthForm(ctx, m.httpClient(), codexTokenURL, form)
	if err != nil {
		m.fail(state, err)
		return err
	}
	document := oauthDocument("codex", tokens, "https://chatgpt.com/backend-api/codex", "")
	claims := jwtClaims(anyString(tokens["id_token"]))
	document["account_id"] = firstNonEmpty(claimString(claims, "chatgpt_account_id"), nestedClaimString(claims, "https://api.openai.com/auth", "chatgpt_account_id"))
	document["email"] = claimString(claims, "email")
	return m.capture(ctx, session, document)
}

func (m *oauthManager) startDevice(ctx context.Context, provider, deviceID string) (deviceAuthorization, string, error) {
	if provider == "kimi" {
		form := url.Values{"client_id": {kimiClientID}}
		var result deviceAuthorization
		err := postFormJSONHeaders(ctx, m.httpClient(), "https://auth.kimi.com/api/oauth/device_authorization", form, kimiOAuthHeaders(deviceID), &result)
		return result, kimiTokenURL, err
	}
	var discovery struct {
		DeviceURL string `json:"device_authorization_endpoint"`
		TokenURL  string `json:"token_endpoint"`
	}
	if err := getJSON(ctx, m.httpClient(), "https://auth.x.ai/.well-known/openid-configuration", &discovery); err != nil {
		return deviceAuthorization{}, "", err
	}
	if err := validateXAIEndpoint(discovery.DeviceURL); err != nil {
		return deviceAuthorization{}, "", err
	}
	if err := validateXAIEndpoint(discovery.TokenURL); err != nil {
		return deviceAuthorization{}, "", err
	}
	form := url.Values{"client_id": {xaiClientID}, "scope": {"openid profile email offline_access grok-cli:access api:access"}}
	var result deviceAuthorization
	err := postFormJSON(ctx, m.httpClient(), discovery.DeviceURL, form, &result)
	return result, discovery.TokenURL, err
}

func (m *oauthManager) pollDevice(ctx context.Context, session *oauthRuntimeSession, device deviceAuthorization) {
	interval := time.Duration(device.Interval) * time.Second
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	expires := time.Duration(device.ExpiresIn) * time.Second
	if expires <= 0 || expires > 30*time.Minute {
		expires = 30 * time.Minute
	}
	deadline := time.NewTimer(expires)
	ticker := time.NewTicker(interval)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			m.fail(session.state, fmt.Errorf("device authorization expired"))
			return
		case <-ticker.C:
			clientID := kimiClientID
			if session.provider == "xai" {
				clientID = xaiClientID
			}
			form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {session.deviceCode}, "client_id": {clientID}}
			var tokens map[string]any
			var err error
			if session.provider == "kimi" {
				tokens, err = postOAuthFormHeaders(ctx, m.httpClient(), session.tokenURL, form, kimiOAuthHeaders(session.deviceID))
			} else {
				tokens, err = postOAuthForm(ctx, m.httpClient(), session.tokenURL, form)
			}
			if err != nil {
				if strings.Contains(err.Error(), "authorization_pending") || strings.Contains(err.Error(), "slow_down") {
					continue
				}
				m.fail(session.state, err)
				return
			}
			base := "https://api.kimi.com/coding/v1"
			if session.provider == "xai" {
				base = "https://api.x.ai/v1"
			}
			document := oauthDocument(session.provider, tokens, base, session.tokenURL)
			if session.provider == "kimi" {
				document["device_id"] = session.deviceID
			}
			claims := jwtClaims(anyString(tokens["id_token"]))
			document["email"] = claimString(claims, "email")
			if err = m.capture(context.Background(), session, document); err != nil {
				m.fail(session.state, err)
			}
			return
		}
	}
}

func (m *oauthManager) capture(ctx context.Context, session *oauthRuntimeSession, document map[string]any) error {
	payload, err := json.Marshal(document)
	if err == nil && m.options.OnOAuthCredential != nil {
		err = m.options.OnOAuthCredential(ctx, session.relaySession, session.provider, firstNonEmpty(anyString(document["email"]), session.provider+" OAuth"), payload)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if current := m.sessions[session.state]; current != nil {
		if err != nil {
			current.err = err.Error()
			current.status = "error"
		} else {
			current.status = "ok"
		}
	}
	return err
}

func (m *oauthManager) fail(state string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if session := m.sessions[state]; session != nil {
		session.status, session.err = "error", err.Error()
	}
}

func (m *oauthManager) cancel(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if session := m.sessions[strings.TrimSpace(state)]; session != nil {
		if session.cancel != nil {
			session.cancel()
		}
		delete(m.sessions, state)
	}
}

func (m *oauthManager) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for state, session := range m.sessions {
		if session.cancel != nil {
			session.cancel()
		}
		delete(m.sessions, state)
	}
}

func oauthDocument(provider string, tokens map[string]any, baseURL, tokenURL string) map[string]any {
	result := map[string]any{"type": provider, "access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "id_token": tokens["id_token"], "token_type": tokens["token_type"], "base_url": baseURL, "auth_kind": "oauth"}
	if expiry := oauthExpiry(tokens, anyString(tokens["access_token"]), time.Now()); !expiry.IsZero() {
		result["expired"] = expiry.UTC().Format(time.RFC3339)
	}
	if tokenURL != "" {
		result["token_endpoint"] = tokenURL
	}
	return result
}

func oauthTokenEndpoint(provider string, document map[string]any) string {
	if endpoint := firstString(document, "token_endpoint"); endpoint != "" {
		return endpoint
	}
	switch provider {
	case "codex":
		return codexTokenURL
	case "kimi":
		return kimiTokenURL
	case "xai":
		return xaiTokenURL
	default:
		return ""
	}
}

func oauthRefreshForm(provider, refreshToken string) url.Values {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	switch provider {
	case "codex":
		form.Set("client_id", codexClientID)
		form.Set("scope", codexRefreshScope)
	case "kimi":
		form.Set("client_id", kimiClientID)
	case "xai":
		form.Set("client_id", xaiClientID)
	}
	return form
}

func applyRefreshedTokens(credential *nativeCredential, tokens map[string]any, tokenEndpoint string, now time.Time) {
	credential.AccessToken = anyString(tokens["access_token"])
	if refresh := anyString(tokens["refresh_token"]); refresh != "" {
		credential.RefreshToken = refresh
	}
	credential.document["access_token"] = credential.AccessToken
	credential.document["refresh_token"] = credential.RefreshToken
	if idToken := anyString(tokens["id_token"]); idToken != "" {
		credential.document["id_token"] = idToken
		claims := jwtClaims(idToken)
		if email := claimString(claims, "email"); email != "" {
			credential.document["email"] = email
		}
		if credential.Provider == "codex" {
			accountID := firstNonEmpty(claimString(claims, "chatgpt_account_id"), nestedClaimString(claims, "https://api.openai.com/auth", "chatgpt_account_id"))
			if accountID != "" {
				credential.AccountID = accountID
				credential.document["account_id"] = accountID
			}
		}
		if credential.Provider == "xai" {
			if subject := claimString(claims, "sub"); subject != "" {
				credential.document["sub"] = subject
			}
		}
	}
	if tokenEndpoint != "" && firstString(credential.document, "token_endpoint") == "" {
		credential.document["token_endpoint"] = tokenEndpoint
	}
	credential.expiresAt = oauthExpiry(tokens, credential.AccessToken, now)
	credential.document["expired"] = credential.expiresAt.UTC().Format(time.RFC3339)
}

func oauthExpiry(tokens map[string]any, accessToken string, now time.Time) time.Time {
	if seconds := anyPositiveSeconds(tokens["expires_in"]); seconds > 0 {
		return now.Add(time.Duration(seconds) * time.Second)
	}
	if exp := jwtUnixTime(accessToken, "exp"); exp.After(now) {
		return exp
	}
	return now.Add(time.Hour)
}

func anyPositiveSeconds(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 {
			return int64(typed)
		}
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil && parsed > 0 {
			return parsed
		}
		asFloat, err := typed.Float64()
		if err == nil && asFloat > 0 {
			return int64(asFloat)
		}
	case int:
		if typed > 0 {
			return int64(typed)
		}
	case int64:
		if typed > 0 {
			return typed
		}
	case string:
		parsed, err := json.Number(strings.TrimSpace(typed)).Int64()
		if err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}

func jwtUnixTime(token, claim string) time.Time {
	seconds := anyPositiveSeconds(jwtClaims(token)[claim])
	if seconds <= 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0).UTC()
}

func postOAuthForm(ctx context.Context, client *http.Client, endpoint string, form url.Values) (map[string]any, error) {
	return postOAuthFormHeaders(ctx, client, endpoint, form, nil)
}

func postOAuthFormHeaders(ctx context.Context, client *http.Client, endpoint string, form url.Values, headers http.Header) (map[string]any, error) {
	var result map[string]any
	if err := postFormJSONHeaders(ctx, client, endpoint, form, headers, &result); err != nil {
		return nil, err
	}
	if oauthError := anyString(result["error"]); oauthError != "" {
		return nil, fmt.Errorf("OAuth token endpoint: %s: %s", oauthError, anyString(result["error_description"]))
	}
	if anyString(result["access_token"]) == "" {
		return nil, fmt.Errorf("OAuth token endpoint returned no access token")
	}
	return result, nil
}

func postFormJSON(ctx context.Context, client *http.Client, endpoint string, form url.Values, target any) error {
	return postFormJSONHeaders(ctx, client, endpoint, form, nil, target)
}

func postFormJSONHeaders(ctx context.Context, client *http.Client, endpoint string, form url.Values, headers http.Header, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	return doJSON(client, request, target)
}

func kimiOAuthHeaders(deviceID string) http.Header {
	return http.Header{
		"X-Msh-Platform": {"RelayAPI"}, "X-Msh-Version": {"native"},
		"X-Msh-Device-Name": {"RelayAPI"}, "X-Msh-Device-Model": {"server"},
		"X-Msh-Device-Id": {strings.TrimSpace(deviceID)},
	}
}

func getJSON(ctx context.Context, client *http.Client, endpoint string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	return doJSON(client, request, target)
}

func doJSON(client *http.Client, request *http.Request, target any) error {
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("OAuth endpoint returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if err = json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode OAuth response: %w", err)
	}
	return nil
}

func validateXAIEndpoint(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" {
		return fmt.Errorf("xAI OAuth endpoint must use HTTPS")
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "x.ai" && !strings.HasSuffix(host, ".x.ai") {
		return fmt.Errorf("xAI OAuth endpoint is outside x.ai")
	}
	return nil
}

func randomURLToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}
func sha256Sum(value []byte) []byte { sum := sha256.Sum256(value); return sum[:] }
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	_ = json.Unmarshal(payload, &claims)
	return claims
}
func claimString(claims map[string]any, key string) string { return anyString(claims[key]) }
func nestedClaimString(claims map[string]any, key, nested string) string {
	value, _ := claims[key].(map[string]any)
	return anyString(value[nested])
}
