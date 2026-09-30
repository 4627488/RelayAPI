package relaybridge

import (
	"strings"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

// The SDK re-exports Config but not DisableImageGenerationMode or its enum
// constants. Keep that missing public configuration seam isolated here.
func imageGenerationMode(value string) internalconfig.DisableImageGenerationMode {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "all":
		return internalconfig.DisableImageGenerationAll
	case "chat":
		return internalconfig.DisableImageGenerationChat
	case "passthrough":
		return internalconfig.DisableImageGenerationPassthrough
	default:
		return internalconfig.DisableImageGenerationOff
	}
}
