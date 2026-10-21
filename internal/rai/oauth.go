package rai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var errOAuthLoginRequired = errors.New("device authorization expired or was revoked; run rai auth login --server <url>")

func validateVerificationURL(server, verificationURI string) error {
	link, err := url.Parse(verificationURI)
	origin, _ := url.Parse(server)
	if err != nil || link.Scheme != origin.Scheme || link.Host != origin.Host || link.User != nil || strings.ContainsAny(verificationURI, "\r\n\x1b") {
		return errors.New("device authorization URL must use the requested server origin")
	}
	return nil
}

func (a *App) reauthorizeProfile(ctx context.Context, store Store, profile Profile, noBrowser ...bool) (Profile, string, error) {
	args := []string{"--server", profile.ServerURL}
	if len(noBrowser) > 0 && noBrowser[0] {
		args = append(args, "--no-browser")
	}
	if err := a.login(ctx, profile.Name, args); err != nil {
		return profile, "", err
	}
	updated, err := store.ResolveProfile(profile.Name)
	if err != nil {
		return profile, "", err
	}
	secret, err := a.profileCredential(ctx, store, updated)
	return updated, secret, err
}

type oauthCredential struct {
	Kind         string    `json:"kind"`
	ServerURL    string    `json:"server_url"`
	Purpose      string    `json:"purpose"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

func encodeOAuthCredential(server string, tokens TokenResult, now time.Time) string {
	raw, _ := json.Marshal(oauthCredential{Kind: "rai.oauth/v1", ServerURL: server, Purpose: tokens.Purpose,
		AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresAt: now.Add(time.Duration(tokens.ExpiresIn) * time.Second)})
	return string(raw)
}

func decodeOAuthCredential(raw string) (oauthCredential, bool, error) {
	if !strings.HasPrefix(strings.TrimSpace(raw), "{") {
		return oauthCredential{}, false, nil
	}
	var saved oauthCredential
	if json.Unmarshal([]byte(raw), &saved) != nil || saved.Kind != "rai.oauth/v1" || !strings.HasPrefix(saved.AccessToken, "rai_at_") || !strings.HasPrefix(saved.RefreshToken, "rai_rt_") || saved.ExpiresAt.IsZero() {
		return saved, true, errors.New("invalid saved OAuth credential; sign in again")
	}
	return saved, true, nil
}

func (g Gateway) refreshOAuth(ctx context.Context, server, refresh string) (TokenResult, error) {
	var result TokenResult
	base, err := managementServer(server)
	if err != nil {
		return result, err
	}
	body, _ := json.Marshal(map[string]string{"grant_type": "refresh_token", "refresh_token": refresh})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/rai/token", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.managementGateway().HTTP.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 410 {
		return result, errOAuthLoginRequired
	}
	if resp.StatusCode != 200 {
		return result, fmt.Errorf("OAuth refresh returned HTTP %d", resp.StatusCode)
	}
	var document struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Purpose      string `json:"purpose"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&document); err != nil {
		return result, errors.New("invalid OAuth refresh response")
	}
	if !strings.HasPrefix(document.AccessToken, "rai_at_") || !strings.HasPrefix(document.RefreshToken, "rai_rt_") || document.ExpiresIn <= 0 || document.ExpiresIn > 900 {
		return result, errors.New("invalid OAuth refresh response")
	}
	return TokenResult{AccessToken: document.AccessToken, RefreshToken: document.RefreshToken, Purpose: document.Purpose, ExpiresIn: document.ExpiresIn}, nil
}

func (g Gateway) revokeOAuth(ctx context.Context, saved oauthCredential) error {
	base, err := managementServer(saved.ServerURL)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"token": saved.RefreshToken})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/rai/revoke", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.managementGateway().HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 && resp.StatusCode != 200 {
		return fmt.Errorf("OAuth revocation returned HTTP %d; authorization was retained for retry", resp.StatusCode)
	}
	return nil
}

func (a *App) profileCredential(ctx context.Context, store Store, profile Profile) (string, error) {
	return a.oauthAccessToken(ctx, store, profile, profileCredentialName(profile), "inference")
}

func profileCredentialName(profile Profile) string {
	// A legacy rai binary must never print an OAuth bundle as if it were a Key.
	if profile.AuthMethod == "oauth" {
		return "oauth/" + profile.Name
	}
	return profile.Name
}

func (a *App) revokeSavedCredential(ctx context.Context, store Store, name string) error {
	raw, err := store.Credential(name)
	if err != nil {
		return err
	}
	saved, oauth, err := decodeOAuthCredential(raw)
	if err != nil {
		return err
	}
	if oauth {
		return a.Gateway.revokeOAuth(ctx, saved)
	}
	return nil
}

func (a *App) oauthAccessToken(ctx context.Context, store Store, profile Profile, credentialName, purpose string) (string, error) {
	read := func() (string, oauthCredential, bool, error) {
		raw, err := store.Credential(credentialName)
		if err != nil {
			return "", oauthCredential{}, false, err
		}
		saved, oauth, err := decodeOAuthCredential(raw)
		if err != nil {
			return "", saved, oauth, err
		}
		if oauth && (saved.ServerURL != profile.ServerURL || saved.Purpose != purpose) {
			return "", saved, true, errors.New("OAuth credential does not match this server or purpose; sign in again")
		}
		return raw, saved, oauth, nil
	}
	raw, saved, oauth, err := read()
	if err != nil {
		return "", err
	}
	if !oauth {
		if purpose != "inference" {
			return "", errors.New("account management requires OAuth login")
		}
		return raw, nil // Explicit --api-key-stdin credentials remain supported.
	}
	if a.Now().Add(2 * time.Minute).Before(saved.ExpiresAt) {
		return saved.AccessToken, nil
	}
	// Serialize rotating refresh tokens across concurrent credential helpers.
	unlock, err := a.lockOAuthCredential(ctx, store, credentialName)
	if err != nil {
		return "", err
	}
	defer unlock()
	_, saved, _, err = read()
	if err != nil {
		return "", err
	}
	if a.Now().Add(2 * time.Minute).Before(saved.ExpiresAt) {
		return saved.AccessToken, nil
	}
	result, err := a.Gateway.refreshOAuth(ctx, saved.ServerURL, saved.RefreshToken)
	if err != nil {
		return "", err
	}
	if result.Purpose != purpose {
		return "", errors.New("OAuth refresh changed authorization purpose")
	}
	if _, err := store.PutCredential(credentialName, encodeOAuthCredential(saved.ServerURL, result, a.Now())); err != nil {
		return "", err
	}
	return result.AccessToken, nil
}

func (a *App) lockOAuthCredential(ctx context.Context, store Store, name string) (func(), error) {
	hash := sha256.Sum256([]byte(name))
	file, err := os.OpenFile(filepath.Join(store.Home, "oauth-"+hex.EncodeToString(hash[:8])+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		locked, err := tryOAuthFileLock(file)
		if err != nil {
			_ = file.Close()
			return nil, err
		}
		if locked {
			return func() { _ = file.Close() }, nil
		}
		if err := a.Sleep(ctx, 25*time.Millisecond); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
}
