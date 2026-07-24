package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr          string
	DatabaseURL         string
	CPAURL              string
	CPAAPIKey           string
	CPAManagementKey    string
	AdminAccessKey      string
	SessionSecret       string
	PublicURL           string
	SecureCookies       bool
	ReservationNanoUSD  int64
	RequestTimeout      time.Duration
	UnpricedModelPolicy string
	CPAPluginSecret     string
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:          env("LISTEN_ADDR", ":3000"),
		DatabaseURL:         strings.TrimSpace(os.Getenv("DATABASE_URL")),
		CPAURL:              strings.TrimRight(env("CPA_URL", "http://cliproxyapi:8317"), "/"),
		CPAAPIKey:           strings.TrimSpace(os.Getenv("CPA_API_KEY")),
		CPAManagementKey:    strings.TrimSpace(os.Getenv("CPA_MANAGEMENT_KEY")),
		AdminAccessKey:      strings.TrimSpace(firstEnv("RELAY_ADMIN_KEY", "RELAY_WEB_ACCESS_KEY")),
		SessionSecret:       strings.TrimSpace(os.Getenv("RELAY_SESSION_SECRET")),
		PublicURL:           strings.TrimRight(env("RELAY_PUBLIC_URL", "http://localhost:3000"), "/"),
		SecureCookies:       envBool("RELAY_SECURE_COOKIES", false),
		ReservationNanoUSD:  envInt64("BILLING_RESERVE_NANO_USD", 10_000_000),
		RequestTimeout:      time.Duration(envInt64("CPA_REQUEST_TIMEOUT_SECONDS", 600)) * time.Second,
		UnpricedModelPolicy: strings.ToLower(env("UNPRICED_MODEL_POLICY", "allow")),
		CPAPluginSecret:     strings.TrimSpace(os.Getenv("CPA_PLUGIN_SECRET")),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.CPAAPIKey == "" {
		return Config{}, errors.New("CPA_API_KEY is required")
	}
	if len(cfg.AdminAccessKey) < 16 {
		return Config{}, errors.New("RELAY_ADMIN_KEY must contain at least 16 characters")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, errors.New("RELAY_SESSION_SECRET must contain at least 32 characters")
	}
	if cfg.ReservationNanoUSD < 0 {
		return Config{}, errors.New("BILLING_RESERVE_NANO_USD cannot be negative")
	}
	if cfg.UnpricedModelPolicy != "allow" && cfg.UnpricedModelPolicy != "deny" {
		return Config{}, errors.New("UNPRICED_MODEL_POLICY must be allow or deny")
	}
	for name, value := range map[string]string{"CPA_URL": cfg.CPAURL, "RELAY_PUBLIC_URL": cfg.PublicURL} {
		if parsed, err := url.Parse(value); err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return Config{}, fmt.Errorf("%s must be an absolute URL", name)
		}
	}
	return cfg, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

func envInt64(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
