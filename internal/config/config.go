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
	ListenAddr                     string
	DatabaseURL                    string
	SessionSecret                  string
	APIKeyEncryptionKey            string
	PublicURL                      string
	SecureCookies                  bool
	ReservationNanoUSD             int64
	ImageReservationNanoUSD        int64
	RequestTimeout                 time.Duration
	GatewayMaxInFlight             int
	GatewayMaxQueue                int
	GatewayQueueTimeout            time.Duration
	MaxRequestBytes                int64
	RequestBytesInFlight           int64
	MemoryReclaimThresholdBytes    uint64
	GatewayCircuitFailureThreshold int
	GatewayCircuitOpenDuration     time.Duration
	QuotaSyncInterval              time.Duration
	UpstreamWebSockets             bool
	UnpricedModelPolicy            string
	WebDistDir                     string
	RequestLogRetentionDays        int
	RequestDetailRetentionDays     int
	RequestSuccessDetailDays       int
	RequestSuccessSamplePPM        int
	LifecycleSuccessHours          int
	LifecycleErrorDays             int
	ReservationRetentionDays       int
	IncompleteReservationDays      int
	QuotaObservationDays           int
	InvitationRetentionDays        int
	RetentionBatchSize             int
	RetentionMaxRuntime            time.Duration
	CPAImportAuthDir               string
	CPAImportConfigPath            string
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:                     env("LISTEN_ADDR", ":3000"),
		DatabaseURL:                    strings.TrimSpace(os.Getenv("DATABASE_URL")),
		SessionSecret:                  strings.TrimSpace(os.Getenv("RELAY_SESSION_SECRET")),
		APIKeyEncryptionKey:            strings.TrimSpace(os.Getenv("RELAY_API_KEY_ENCRYPTION_KEY")),
		PublicURL:                      strings.TrimRight(env("RELAY_PUBLIC_URL", "http://localhost:3000"), "/"),
		SecureCookies:                  envBool("RELAY_SECURE_COOKIES", false),
		ReservationNanoUSD:             envInt64("BILLING_RESERVE_NANO_USD", 10_000_000),
		ImageReservationNanoUSD:        envInt64("BILLING_IMAGE_RESERVE_NANO_USD", 500_000_000),
		RequestTimeout:                 time.Duration(envInt64("RELAY_REQUEST_TIMEOUT_SECONDS", 86400)) * time.Second,
		GatewayMaxInFlight:             int(envInt64("RELAY_MAX_IN_FLIGHT", 8)),
		GatewayMaxQueue:                int(envInt64("RELAY_MAX_QUEUE", 16)),
		GatewayQueueTimeout:            time.Duration(envInt64("RELAY_QUEUE_TIMEOUT_MILLISECONDS", 2_000)) * time.Millisecond,
		MaxRequestBytes:                envInt64("RELAY_MAX_REQUEST_MIB", 1024) << 20,
		RequestBytesInFlight:           envInt64("RELAY_REQUEST_BYTES_IN_FLIGHT_MIB", 8192) << 20,
		MemoryReclaimThresholdBytes:    uint64(envInt64("RELAY_MEMORY_RECLAIM_THRESHOLD_MIB", 8192)) << 20,
		GatewayCircuitFailureThreshold: int(envInt64("RELAY_CIRCUIT_FAILURE_THRESHOLD", 0)),
		GatewayCircuitOpenDuration:     time.Duration(envInt64("RELAY_CIRCUIT_OPEN_SECONDS", 15)) * time.Second,
		QuotaSyncInterval:              time.Duration(envInt64("RELAY_QUOTA_SYNC_INTERVAL_SECONDS", 300)) * time.Second,
		UpstreamWebSockets:             envBool("RELAY_UPSTREAM_WEBSOCKETS", true),
		UnpricedModelPolicy:            strings.ToLower(env("UNPRICED_MODEL_POLICY", "allow")),
		WebDistDir:                     strings.TrimSpace(os.Getenv("RELAY_WEB_DIST_DIR")),
		RequestLogRetentionDays:        int(envInt64("REQUEST_LOG_RETENTION_DAYS", 30)),
		RequestDetailRetentionDays:     int(envInt64("REQUEST_LOG_DETAIL_RETENTION_DAYS", 14)),
		RequestSuccessDetailDays:       int(envInt64("REQUEST_LOG_SUCCESS_DETAIL_DAYS", 1)),
		RequestSuccessSamplePPM:        int(envInt64("REQUEST_LOG_SUCCESS_SAMPLE_PPM", 0)),
		LifecycleSuccessHours:          int(envInt64("RELAY_LIFECYCLE_SUCCESS_HOURS", 24)),
		LifecycleErrorDays:             int(envInt64("RELAY_LIFECYCLE_ERROR_DAYS", 7)),
		ReservationRetentionDays:       int(envInt64("REQUEST_RESERVATION_RETENTION_DAYS", 14)),
		IncompleteReservationDays:      int(envInt64("INCOMPLETE_RESERVATION_RETENTION_DAYS", 90)),
		QuotaObservationDays:           int(envInt64("QUOTA_OBSERVATION_RETENTION_DAYS", 180)),
		InvitationRetentionDays:        int(envInt64("INVITATION_RETENTION_DAYS", 30)),
		RetentionBatchSize:             int(envInt64("RETENTION_BATCH_SIZE", 5_000)),
		RetentionMaxRuntime:            time.Duration(envInt64("RETENTION_MAX_RUNTIME_SECONDS", 30)) * time.Second,
		CPAImportAuthDir:               strings.TrimSpace(os.Getenv("RELAY_CPA_IMPORT_AUTH_DIR")),
		CPAImportConfigPath:            strings.TrimSpace(os.Getenv("RELAY_CPA_IMPORT_CONFIG")),
	}
	if cfg.APIKeyEncryptionKey == "" {
		cfg.APIKeyEncryptionKey = cfg.SessionSecret
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, errors.New("RELAY_SESSION_SECRET must contain at least 32 characters")
	}
	if len(cfg.APIKeyEncryptionKey) < 32 {
		return Config{}, errors.New("RELAY_API_KEY_ENCRYPTION_KEY must contain at least 32 characters")
	}
	if cfg.ReservationNanoUSD < 0 {
		return Config{}, errors.New("BILLING_RESERVE_NANO_USD cannot be negative")
	}
	if cfg.ImageReservationNanoUSD < 0 {
		return Config{}, errors.New("BILLING_IMAGE_RESERVE_NANO_USD cannot be negative")
	}
	if cfg.RequestTimeout < time.Second || cfg.RequestTimeout > 24*time.Hour {
		return Config{}, errors.New("RELAY_REQUEST_TIMEOUT_SECONDS must be between 1 and 86400")
	}
	if cfg.GatewayMaxInFlight < 1 || cfg.GatewayMaxInFlight > 1024 {
		return Config{}, errors.New("RELAY_MAX_IN_FLIGHT must be between 1 and 1024")
	}
	if cfg.GatewayMaxQueue < 0 || cfg.GatewayMaxQueue > 10_000 {
		return Config{}, errors.New("RELAY_MAX_QUEUE must be between 0 and 10000")
	}
	if cfg.GatewayQueueTimeout < 0 || cfg.GatewayQueueTimeout > time.Minute {
		return Config{}, errors.New("RELAY_QUEUE_TIMEOUT_MILLISECONDS must be between 0 and 60000")
	}
	if cfg.MaxRequestBytes < 1<<20 || cfg.MaxRequestBytes > 64<<30 {
		return Config{}, errors.New("RELAY_MAX_REQUEST_MIB must be between 1 and 65536")
	}
	if cfg.RequestBytesInFlight < cfg.MaxRequestBytes || cfg.RequestBytesInFlight > 256<<30 {
		return Config{}, errors.New("RELAY_REQUEST_BYTES_IN_FLIGHT_MIB must be at least RELAY_MAX_REQUEST_MIB and at most 262144")
	}
	if cfg.MemoryReclaimThresholdBytes < 64<<20 || cfg.MemoryReclaimThresholdBytes > 512<<30 {
		return Config{}, errors.New("RELAY_MEMORY_RECLAIM_THRESHOLD_MIB must be between 64 and 524288")
	}
	if cfg.GatewayCircuitFailureThreshold < 0 || cfg.GatewayCircuitFailureThreshold > 100 {
		return Config{}, errors.New("RELAY_CIRCUIT_FAILURE_THRESHOLD must be between 0 and 100")
	}
	if cfg.GatewayCircuitOpenDuration < time.Second || cfg.GatewayCircuitOpenDuration > 10*time.Minute {
		return Config{}, errors.New("RELAY_CIRCUIT_OPEN_SECONDS must be between 1 and 600")
	}
	if cfg.QuotaSyncInterval < time.Minute {
		return Config{}, errors.New("RELAY_QUOTA_SYNC_INTERVAL_SECONDS must be at least 60")
	}
	if cfg.UnpricedModelPolicy != "allow" && cfg.UnpricedModelPolicy != "deny" {
		return Config{}, errors.New("UNPRICED_MODEL_POLICY must be allow or deny")
	}
	if cfg.RequestLogRetentionDays < 0 || cfg.RequestDetailRetentionDays < 0 || cfg.RequestSuccessDetailDays < 0 ||
		cfg.LifecycleSuccessHours < 0 || cfg.LifecycleErrorDays < 0 || cfg.ReservationRetentionDays < 0 ||
		cfg.IncompleteReservationDays < 0 || cfg.QuotaObservationDays < 0 || cfg.InvitationRetentionDays < 0 {
		return Config{}, errors.New("request log retention days cannot be negative")
	}
	if cfg.RequestSuccessSamplePPM < 0 || cfg.RequestSuccessSamplePPM > 1_000_000 {
		return Config{}, errors.New("REQUEST_LOG_SUCCESS_SAMPLE_PPM must be between 0 and 1000000")
	}
	if cfg.RetentionBatchSize < 100 || cfg.RetentionBatchSize > 100_000 {
		return Config{}, errors.New("RETENTION_BATCH_SIZE must be between 100 and 100000")
	}
	if cfg.RetentionMaxRuntime < time.Second || cfg.RetentionMaxRuntime > 10*time.Minute {
		return Config{}, errors.New("RETENTION_MAX_RUNTIME_SECONDS must be between 1 and 600")
	}
	for name, value := range map[string]string{"RELAY_PUBLIC_URL": cfg.PublicURL} {
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
