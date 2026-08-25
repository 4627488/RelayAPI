package rai

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

var profileNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var supportedReasoningEfforts = []string{"minimal", "low", "medium", "high", "xhigh"}

type Config struct {
	Kind          string             `json:"kind"`
	ActiveProfile string             `json:"active_profile"`
	Profiles      map[string]Profile `json:"profiles"`
}

type Profile struct {
	Name              string    `json:"name"`
	ServerURL         string    `json:"server_url"`
	DisplayName       string    `json:"display_name,omitempty"`
	DefaultModel      string    `json:"default_model,omitempty"`
	ReasoningEffort   string    `json:"reasoning_effort,omitempty"`
	OpenCodeProtocol  string    `json:"opencode_protocol,omitempty"`
	CredentialBackend string    `json:"credential_backend,omitempty"`
	LastRefresh       time.Time `json:"last_refresh,omitempty"`
}

type Store struct {
	Home string
}

func OpenStore(home string) (Store, error) {
	if home == "" {
		var err error
		home, err = defaultHomeDir()
		if err != nil {
			return Store{}, err
		}
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return Store{}, err
	}
	return Store{Home: home}, nil
}

func (s Store) configPath() string {
	return filepath.Join(s.Home, "config.json")
}

func (s Store) Load() (Config, error) {
	raw, err := os.ReadFile(s.configPath())
	if errors.Is(err, os.ErrNotExist) {
		return Config{Kind: configKind, Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse rai config: %w", err)
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]Profile{}
	}
	if cfg.Kind == "" {
		cfg.Kind = configKind
	}
	return cfg, nil
}

func (s Store) Save(cfg Config) error {
	cfg.Kind = configKind
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]Profile{}
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeFileAtomic(s.configPath(), raw, 0o600)
}

func (s Store) PutProfile(profile Profile) error {
	if err := validateProfile(profile); err != nil {
		return err
	}
	cfg, err := s.Load()
	if err != nil {
		return err
	}
	cfg.Profiles[profile.Name] = profile
	if cfg.ActiveProfile == "" {
		cfg.ActiveProfile = profile.Name
	}
	return s.Save(cfg)
}

func (s Store) SetActive(name string) error {
	if err := validateProfileName(name); err != nil {
		return err
	}
	cfg, err := s.Load()
	if err != nil {
		return err
	}
	if _, ok := cfg.Profiles[name]; !ok {
		return fmt.Errorf("profile %q is not configured", name)
	}
	cfg.ActiveProfile = name
	return s.Save(cfg)
}

func (s Store) DeleteProfile(name string) error {
	cfg, err := s.Load()
	if err != nil {
		return err
	}
	delete(cfg.Profiles, name)
	if cfg.ActiveProfile == name {
		cfg.ActiveProfile = ""
		for next := range cfg.Profiles {
			cfg.ActiveProfile = next
			break
		}
	}
	return s.Save(cfg)
}

func (s Store) ResolveProfile(explicit string) (Profile, error) {
	name := strings.TrimSpace(explicit)
	if name == "" {
		name = strings.TrimSpace(os.Getenv(envProfile))
	}
	cfg, err := s.Load()
	if err != nil {
		return Profile{}, err
	}
	if name == "" {
		name = cfg.ActiveProfile
	}
	if name == "" {
		return Profile{}, errors.New("no rai profile is configured; run rai login --server <url> --api-key-stdin")
	}
	profile, ok := cfg.Profiles[name]
	if !ok {
		return Profile{}, fmt.Errorf("profile %q is not configured", name)
	}
	return profile, nil
}

func validateProfileName(name string) error {
	if !profileNamePattern.MatchString(name) {
		return errors.New("profile name must be 1-64 letters, digits, dots, underscores, or hyphens")
	}
	return nil
}

func validateProfile(profile Profile) error {
	if err := validateProfileName(profile.Name); err != nil {
		return err
	}
	if _, err := normalizeServerURL(profile.ServerURL); err != nil {
		return err
	}
	if profile.ReasoningEffort != "" && !slices.Contains(supportedReasoningEfforts, profile.ReasoningEffort) {
		return fmt.Errorf("reasoning effort %q is invalid", profile.ReasoningEffort)
	}
	if profile.OpenCodeProtocol != "" && profile.OpenCodeProtocol != "responses" && profile.OpenCodeProtocol != "chat" {
		return errors.New("OpenCode protocol must be responses or chat")
	}
	return nil
}

func normalizeServerURL(raw string) (string, error) {
	value := strings.TrimRight(strings.TrimSpace(raw), "/")
	if value == "" {
		return "", errors.New("server URL is required")
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		return "", errors.New("server URL must start with http:// or https://")
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return "", errors.New("server URL is invalid")
	}
	return value, nil
}
