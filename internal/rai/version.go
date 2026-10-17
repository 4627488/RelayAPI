package rai

// Version is the launcher compatibility version. Release builds override it
// with -ldflags.
var Version = "0.3.0"

const (
	configKind      = "rai.dev/v1"
	credentialKind  = "rai.dev/credentials/v1"
	contractVersion = "2"
	minRAIVersion   = "0.3.0"
	providerID      = "relayapi"
	envAPIKey       = "RAI_API_KEY"
	envProfile      = "RAI_PROFILE"
	envHome         = "RAI_HOME"
	envDisableKey   = "RAI_DISABLE_KEYRING"
	envServer       = "RAI_SERVER"
)
