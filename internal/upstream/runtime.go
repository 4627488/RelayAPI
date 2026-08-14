package upstream

import (
	"context"
	"net/http"
	"time"
)

// Runtime is Relay's provider boundary. It deliberately exposes provider
// facts and lifecycle operations without leaking provider implementation types
// into policy, billing, or public HTTP layers.
type Runtime interface {
	Handler() http.Handler
	CredentialCount() int
	Models() []string
	ModelProvider(string) (string, bool)
	CredentialModels(string) []string
	CredentialStatus(string) (CredentialStatus, bool)
	DiscoverCredentialModels(context.Context, string) ([]string, string, error)
	ReplaceCredentials(context.Context, []Credential) error
	ApplySettings(context.Context, Settings) error
	ResolveCredentialModel(string, string) string
	StartOAuth(context.Context, string, string) (OAuthStartResult, error)
	OAuthStatus(context.Context, string) (OAuthStatusResult, error)
	SubmitOAuthCallback(context.Context, string, string, string) error
	CancelOAuth(context.Context, string) error
	Close(context.Context) error
}

type Credential struct {
	ID       string
	Label    string
	Provider string
	Enabled  bool
	Models   []string
	Document []byte
}

type Options struct {
	APIKey              string
	RequestRetry        int
	MaxRetryInterval    time.Duration
	RoutingStrategy     string
	ProxyURL            string
	PassthroughHeaders  bool
	ForceModelPrefix    bool
	OnCredentialUpdated func(context.Context, string, []byte)
	OnOAuthCredential   func(context.Context, string, string, string, []byte) error
}

type Settings struct {
	RequestRetry       int
	MaxRetryInterval   time.Duration
	RoutingStrategy    string
	ProxyURL           string
	PassthroughHeaders bool
	ForceModelPrefix   bool
}

type CredentialStatus struct {
	Status          string
	StatusMessage   string
	Unavailable     bool
	Success         int64
	Failed          int64
	PlanType        string
	LastRefreshedAt time.Time
	NextRetryAfter  time.Time
	QuotaExceeded   bool
	QuotaReason     string
	QuotaRecoverAt  time.Time
}

type OAuthStartResult struct {
	Status    string `json:"status"`
	URL       string `json:"url"`
	State     string `json:"state"`
	Flow      string `json:"flow,omitempty"`
	UserCode  string `json:"user_code,omitempty"`
	ExpiresIn int    `json:"expires_in,omitempty"`
}

type OAuthStatusResult struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}
