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
	Serve(http.ResponseWriter, *http.Request, []byte)
	ServeModels(http.ResponseWriter, *http.Request)
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
	RefreshCredential(context.Context, string, bool) ([]byte, bool, error)
	RefreshDueCredentials(context.Context) (int, int)
	TakeRequestTrace(string) (RequestTrace, bool)
	Close(context.Context) error
}

// RequestTrace is the secret-free execution trace observed inside the native runtime.
type RequestTrace struct {
	RequestID    string
	StartedAt    time.Time
	CompletedAt  time.Time
	Provider     string
	CredentialID string
	Model        string
	Translation  string
	Attempts     []ExecutionAttempt
	Transfer     TraceTransfer
}

type ExecutionAttempt struct {
	Number                                              int
	StartedAt, CompletedAt, HeadersAt, RequestWrittenAt time.Time
	FirstResponseAt, GetConnAt, GotConnAt               time.Time
	DNSStartedAt, DNSCompletedAt                        time.Time
	ConnectStartedAt, ConnectCompletedAt                time.Time
	TLSStartedAt, TLSCompletedAt                        time.Time
	Status                                              string
	Error                                               string
	Provider                                            string
	Model                                               string
	CredentialID                                        string
	ConnectionReused                                    bool
	RemoteAddr                                          string
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
	RoutingStrategy       string
	ProxyURL              string
	FailureThreshold      int
	FailureCooldown       time.Duration
	ResponseHeaderTimeout time.Duration
	OnCredentialUpdated   func(context.Context, string, []byte)
	OnOAuthCredential     func(context.Context, string, string, string, []byte) error
}

type Settings struct {
	RoutingStrategy       string
	ProxyURL              string
	FailureThreshold      int
	FailureCooldown       time.Duration
	ResponseHeaderTimeout time.Duration
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
