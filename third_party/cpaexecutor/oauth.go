package relaybridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// OAuthStartResult describes a CPA-compatible browser or device authorization session.
type OAuthStartResult struct {
	Status    string `json:"status"`
	URL       string `json:"url"`
	State     string `json:"state"`
	Flow      string `json:"flow,omitempty"`
	UserCode  string `json:"user_code,omitempty"`
	ExpiresIn int    `json:"expires_in,omitempty"`
}

// OAuthStatusResult is the provider authorization state returned by CPA.
type OAuthStatusResult struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type oauthCaptureStore struct {
	baseDir string
	capture func(context.Context, string, string, string, []byte) error
}

func newOAuthCaptureStore(baseDir string, capture func(context.Context, string, string, string, []byte) error) *oauthCaptureStore {
	return &oauthCaptureStore{baseDir: baseDir, capture: capture}
}

func (s *oauthCaptureStore) List(context.Context) ([]*coreauth.Auth, error) { return nil, nil }

func (s *oauthCaptureStore) Delete(context.Context, string) error { return nil }

func (s *oauthCaptureStore) Save(ctx context.Context, auth *coreauth.Auth) (string, error) {
	if auth == nil {
		return "", fmt.Errorf("OAuth credential is nil")
	}
	if strings.TrimSpace(s.baseDir) == "" {
		return "", fmt.Errorf("OAuth workspace is unavailable")
	}
	if err := os.MkdirAll(s.baseDir, 0o700); err != nil {
		return "", err
	}
	var document []byte
	if auth.Storage != nil {
		if auth.Metadata == nil {
			auth.Metadata = make(map[string]any)
		}
		if setter, ok := auth.Storage.(interface{ SetMetadata(map[string]any) }); ok {
			setter.SetMetadata(auth.Metadata)
		}
		file, errTemp := os.CreateTemp(s.baseDir, "credential-*.json")
		if errTemp != nil {
			return "", errTemp
		}
		path := file.Name()
		_ = file.Close()
		defer os.Remove(path)
		if errSave := auth.Storage.SaveTokenToFile(path); errSave != nil {
			return "", errSave
		}
		var errRead error
		document, errRead = os.ReadFile(path)
		if errRead != nil {
			return "", errRead
		}
	} else {
		var errMarshal error
		document, errMarshal = json.Marshal(auth.Metadata)
		if errMarshal != nil {
			return "", errMarshal
		}
	}
	if !json.Valid(document) {
		return "", fmt.Errorf("OAuth provider returned an invalid credential document")
	}
	sessionID := ""
	if info := coreauth.GetRequestInfo(ctx); info != nil {
		sessionID = strings.TrimSpace(info.Query.Get("relay_session"))
	}
	if sessionID == "" {
		return "", fmt.Errorf("Relay OAuth session is missing")
	}
	if s.capture == nil {
		return "", fmt.Errorf("Relay OAuth capture hook is unavailable")
	}
	if errCapture := s.capture(ctx, sessionID, auth.Provider, auth.Label, append([]byte(nil), document...)); errCapture != nil {
		return "", errCapture
	}
	return strings.TrimSpace(auth.FileName), nil
}

func (r *Runtime) StartOAuth(ctx context.Context, provider, sessionID string) (OAuthStartResult, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	paths := map[string]string{
		"claude": "/v0/management/anthropic-auth-url", "codex": "/v0/management/codex-auth-url",
		"antigravity": "/v0/management/antigravity-auth-url", "kimi": "/v0/management/kimi-auth-url",
		"xai": "/v0/management/xai-auth-url",
	}
	path, ok := paths[provider]
	if !ok {
		return OAuthStartResult{}, fmt.Errorf("OAuth is not supported for provider %q", provider)
	}
	query := url.Values{"relay_session": []string{strings.TrimSpace(sessionID)}}
	var result OAuthStartResult
	if err := r.managementJSON(ctx, http.MethodGet, path+"?"+query.Encode(), nil, &result); err != nil {
		return OAuthStartResult{}, err
	}
	if result.Flow == "" {
		if provider == "kimi" || provider == "xai" {
			result.Flow = "device"
		} else {
			result.Flow = "callback"
		}
	}
	return result, nil
}

func (r *Runtime) OAuthStatus(ctx context.Context, state string) (OAuthStatusResult, error) {
	var result OAuthStatusResult
	path := "/v0/management/get-auth-status?" + url.Values{"state": []string{strings.TrimSpace(state)}}.Encode()
	return result, r.managementJSON(ctx, http.MethodGet, path, nil, &result)
}

func (r *Runtime) SubmitOAuthCallback(ctx context.Context, provider, state, redirectURL string) error {
	payload := map[string]string{"provider": provider, "state": state, "redirect_url": redirectURL}
	var result OAuthStatusResult
	return r.managementJSON(ctx, http.MethodPost, "/v0/management/oauth-callback", payload, &result)
}

func (r *Runtime) CancelOAuth(ctx context.Context, state string) error {
	path := "/v0/management/oauth-session?" + url.Values{"state": []string{strings.TrimSpace(state)}}.Encode()
	return r.managementJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (r *Runtime) managementJSON(ctx context.Context, method, path string, body any, target any) error {
	if r == nil || r.handler == nil || r.managementSecret == "" {
		return fmt.Errorf("embedded OAuth broker is unavailable")
	}
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload)).WithContext(ctx)
	request.RemoteAddr = "127.0.0.1:0"
	request.Header.Set("Authorization", "Bearer "+r.managementSecret)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	r.handler.ServeHTTP(recorder, request)
	var response struct {
		Error any `json:"error"`
	}
	if recorder.Code < 200 || recorder.Code >= 300 {
		_ = json.Unmarshal(recorder.Body.Bytes(), &response)
		return fmt.Errorf("CPA OAuth request failed (%d): %v", recorder.Code, response.Error)
	}
	if target != nil && recorder.Body.Len() > 0 {
		if errDecode := json.Unmarshal(recorder.Body.Bytes(), target); errDecode != nil {
			return errDecode
		}
	}
	if result, ok := target.(*OAuthStatusResult); ok && strings.EqualFold(result.Status, "error") {
		return fmt.Errorf("%s", strings.TrimSpace(result.Error))
	}
	return nil
}

var _ coreauth.Store = (*oauthCaptureStore)(nil)
