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
	ListenAddr                 string
	DatabaseURL                string
	SessionSecret              string
	APIKeyEncryptionKey        string
	PublicURL                  string
	SecureCookies              bool
	ReservationNanoUSD         int64
	RequestTimeout             time.Duration
	CPAMaxInFlight             int
	CPAMaxQueue                int
	CPAQueueTimeout            time.Duration
	CPAMaxRequestBytes         int64
	CPARequestBytesInFlight    int64
	ExecutorCachePressureBytes uint64
	CPACircuitFailureThreshold int
	CPACircuitOpenDuration     time.Duration
	QuotaSyncInterval          time.Duration
	UnpricedModelPolicy        string
	CPAImportAuthDir           string
	CPAImportConfigPath        string
	WebDistDir                 string
	RequestLogRetentionDays    int
	RequestDetailRetentionDays int
	RequestSuccessDetailDays   int
	RequestSuccessSamplePPM    int
	LifecycleSuccessHours      int
	LifecycleErrorDays         int
	ReservationRetentionDays   int
	IncompleteReservationDays  int
	QuotaObservationDays       int
	InvitationRetentionDays    int
	RetentionBatchSize         int
	RetentionMaxRuntime        time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:                 env("LISTEN_ADDR", ":3000"),
		DatabaseURL:                strings.TrimSpace(os.Getenv("DATABASE_URL")),
		SessionSecret:              strings.TrimSpace(os.Getenv("RELAY_SESSION_SECRET")),
		APIKeyEncryptionKey:        strings.TrimSpace(os.Getenv("RELAY_API_KEY_ENCRYPTION_KEY")),
		PublicURL:                  strings.TrimRight(env("RELAY_PUBLIC_URL", "http://localhost:3000"), "/"),
		SecureCookies:              envBool("RELAY_SECURE_COOKIES", false),
		ReservationNanoUSD:         envInt64("BILLING_RESERVE_NANO_USD", 10_000_000),
		RequestTimeout:             time.Duration(envInt64("CPA_REQUEST_TIMEOUT_SECONDS", 600)) * time.Second,
		CPAMaxInFlight:             int(envInt64("CPA_MAX_IN_FLIGHT", 16)),
		CPAMaxQueue:                int(envInt64("CPA_MAX_QUEUE", 32)),
		CPAQueueTimeout:            time.Duration(envInt64("CPA_QUEUE_TIMEOUT_MILLISECONDS", 2_000)) * time.Millisecond,
		CPAMaxRequestBytes:         envInt64("CPA_MAX_REQUEST_MIB", 16) << 20,
		CPARequestBytesInFlight:    envInt64("CPA_REQUEST_BYTES_IN_FLIGHT_MIB", 32) << 20,
		ExecutorCachePressureBytes: uint64(envInt64("RELAY_EXECUTOR_CACHE_PRESSURE_MIB", 384)) << 20,
		CPACircuitFailureThreshold: int(envInt64("CPA_CIRCUIT_FAILURE_THRESHOLD", 3)),
		CPACircuitOpenDuration:     time.Duration(envInt64("CPA_CIRCUIT_OPEN_SECONDS", 15)) * time.Second,
		QuotaSyncInterval:          time.Duration(envInt64("CPA_QUOTA_SYNC_INTERVAL_SECONDS", 300)) * time.Second,
		UnpricedModelPolicy:        strings.ToLower(env("UNPRICED_MODEL_POLICY", "allow")),
		CPAImportAuthDir:           strings.TrimSpace(os.Getenv("RELAY_CPA_IMPORT_AUTH_DIR")),
		CPAImportConfigPath:        strings.TrimSpace(os.Getenv("RELAY_CPA_IMPORT_CONFIG")),
		WebDistDir:                 strings.TrimSpace(os.Getenv("RELAY_WEB_DIST_DIR")),
		RequestLogRetentionDays:    int(envInt64("REQUEST_LOG_RETENTION_DAYS", 30)),
		RequestDetailRetentionDays: int(envInt64("REQUEST_LOG_DETAIL_RETENTION_DAYS", 14)),
		RequestSuccessDetailDays:   int(envInt64("REQUEST_LOG_SUCCESS_DETAIL_DAYS", 1)),
		RequestSuccessSamplePPM:    int(envInt64("REQUEST_LOG_SUCCESS_SAMPLE_PPM", 0)),
		LifecycleSuccessHours:      int(envInt64("CPA_LIFECYCLE_SUCCESS_HOURS", 24)),
		LifecycleErrorDays:         int(envInt64("CPA_LIFECYCLE_ERROR_DAYS", 7)),
		ReservationRetentionDays:   int(envInt64("REQUEST_RESERVATION_RETENTION_DAYS", 14)),
		IncompleteReservationDays:  int(envInt64("INCOMPLETE_RESERVATION_RETENTION_DAYS", 90)),
		QuotaObservationDays:       int(envInt64("QUOTA_OBSERVATION_RETENTION_DAYS", 180)),
		InvitationRetentionDays:    int(envInt64("INVITATION_RETENTION_DAYS", 30)),
		RetentionBatchSize:         int(envInt64("RETENTION_BATCH_SIZE", 5_000)),
		RetentionMaxRuntime:        time.Duration(envInt64("RETENTION_MAX_RUNTIME_SECONDS", 30)) * time.Second,
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
	if cfg.RequestTimeout < time.Second || cfg.RequestTimeout > time.Hour {
		return Config{}, errors.New("CPA_REQUEST_TIMEOUT_SECONDS must be between 1 and 3600")
	}
	if cfg.CPAMaxInFlight < 1 || cfg.CPAMaxInFlight > 1024 {
		return Config{}, errors.New("CPA_MAX_IN_FLIGHT must be between 1 and 1024")
	}
	if cfg.CPAMaxQueue < 0 || cfg.CPAMaxQueue > 10_000 {
		return Config{}, errors.New("CPA_MAX_QUEUE must be between 0 and 10000")
	}
	if cfg.CPAQueueTimeout < 0 || cfg.CPAQueueTimeout > time.Minute {
		return Config{}, errors.New("CPA_QUEUE_TIMEOUT_MILLISECONDS must be between 0 and 60000")
	}
	if cfg.CPAMaxRequestBytes < 1<<20 || cfg.CPAMaxRequestBytes > 64<<20 {
		return Config{}, errors.New("CPA_MAX_REQUEST_MIB must be between 1 and 64")
	}
	if cfg.CPARequestBytesInFlight < cfg.CPAMaxRequestBytes || cfg.CPARequestBytesInFlight > 1<<30 {
		return Config{}, errors.New("CPA_REQUEST_BYTES_IN_FLIGHT_MIB must be at least CPA_MAX_REQUEST_MIB and at most 1024")
	}
	if cfg.ExecutorCachePressureBytes < 64<<20 || cfg.ExecutorCachePressureBytes > 8<<30 {
		return Config{}, errors.New("RELAY_EXECUTOR_CACHE_PRESSURE_MIB must be between 64 and 8192")
	}
	if cfg.CPACircuitFailureThreshold < 1 || cfg.CPACircuitFailureThreshold > 100 {
		return Config{}, errors.New("CPA_CIRCUIT_FAILURE_THRESHOLD must be between 1 and 100")
	}
	if cfg.CPACircuitOpenDuration < time.Second || cfg.CPACircuitOpenDuration > 10*time.Minute {
		return Config{}, errors.New("CPA_CIRCUIT_OPEN_SECONDS must be between 1 and 600")
	}
	if cfg.QuotaSyncInterval < time.Minute {
		return Config{}, errors.New("CPA_QUOTA_SYNC_INTERVAL_SECONDS must be at least 60")
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
