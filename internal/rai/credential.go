package rai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

type credentialFile struct {
	Kind string            `json:"kind"`
	Keys map[string]string `json:"keys"`
}

func (s Store) credentialsPath() string {
	return filepath.Join(s.Home, "credentials.json")
}

func (s Store) PutCredential(profile, secret string) (string, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return "", errors.New("API key is empty")
	}
	if strings.ContainsAny(secret, "\r\n") {
		return "", errors.New("API key contains a newline")
	}
	if keyringEnabled() {
		if err := withKeyringTimeout(func() error {
			return keyring.Set(keyringService(), profile, secret)
		}); err == nil {
			_ = s.deleteFileCredential(profile)
			return "keyring", nil
		}
	}
	if err := s.putFileCredential(profile, secret); err != nil {
		return "", err
	}
	return "file", nil
}

func (s Store) Credential(profile string) (string, error) {
	if keyringEnabled() {
		var secret string
		err := withKeyringTimeout(func() error {
			value, getErr := keyring.Get(keyringService(), profile)
			secret = value
			return getErr
		})
		if err == nil && strings.TrimSpace(secret) != "" {
			return strings.TrimSpace(secret), nil
		}
	}
	secret, err := s.fileCredential(profile)
	if err != nil {
		return "", err
	}
	return secret, nil
}

func (s Store) DeleteCredential(profile string) error {
	var keyringErr error
	if keyringEnabled() {
		keyringErr = withKeyringTimeout(func() error {
			return keyring.Delete(keyringService(), profile)
		})
		if errors.Is(keyringErr, keyring.ErrNotFound) {
			keyringErr = nil
		}
	}
	fileErr := s.deleteFileCredential(profile)
	if keyringErr != nil && fileErr != nil {
		return keyringErr
	}
	return nil
}

func (s Store) putFileCredential(profile, secret string) error {
	doc, err := s.loadCredentialFile()
	if err != nil {
		return err
	}
	doc.Keys[profile] = secret
	return s.saveCredentialFile(doc)
}

func (s Store) fileCredential(profile string) (string, error) {
	doc, err := s.loadCredentialFile()
	if err != nil {
		return "", err
	}
	secret := strings.TrimSpace(doc.Keys[profile])
	if secret == "" {
		return "", fmt.Errorf("no credential stored for profile %q", profile)
	}
	return secret, nil
}

func (s Store) deleteFileCredential(profile string) error {
	doc, err := s.loadCredentialFile()
	if err != nil {
		return err
	}
	if _, ok := doc.Keys[profile]; !ok {
		return nil
	}
	delete(doc.Keys, profile)
	if len(doc.Keys) == 0 {
		_ = os.Remove(s.credentialsPath())
		return nil
	}
	return s.saveCredentialFile(doc)
}

func (s Store) loadCredentialFile() (credentialFile, error) {
	raw, err := os.ReadFile(s.credentialsPath())
	if errors.Is(err, os.ErrNotExist) {
		return credentialFile{Kind: credentialKind, Keys: map[string]string{}}, nil
	}
	if err != nil {
		return credentialFile{}, err
	}
	var doc credentialFile
	if err := json.Unmarshal(raw, &doc); err != nil {
		return credentialFile{}, fmt.Errorf("parse rai credentials: %w", err)
	}
	if doc.Keys == nil {
		doc.Keys = map[string]string{}
	}
	return doc, nil
}

func (s Store) saveCredentialFile(doc credentialFile) error {
	doc.Kind = credentialKind
	if doc.Keys == nil {
		doc.Keys = map[string]string{}
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeFileAtomic(s.credentialsPath(), raw, 0o600)
}

func keyringEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envDisableKey))) {
	case "1", "true", "yes":
		return false
	default:
		return true
	}
}

func keyringService() string {
	return "dev.relayapi.rai"
}

func withKeyringTimeout(fn func() error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- fn() }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errc:
		return err
	}
}
