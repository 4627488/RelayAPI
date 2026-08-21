package relaybridge

import (
	"encoding/json"
	"strings"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

// resolveBailianCacheAuth maps Bailian cache_mode=auto onto the CPA executor's
// existing session/off switches. DashScope session cache disables implicit
// prefix cache and only hits when previous_response_id is present; Codex HTTP
// resends the full conversation without that field, so forcing session cache
// produced near-zero hits.
func resolveBailianCacheAuth(auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) *cliproxyauth.Auth {
	if auth == nil || !strings.EqualFold(strings.TrimSpace(auth.Attributes["vendor"]), "aliyun-bailian") {
		return auth
	}
	mode := strings.ToLower(strings.TrimSpace(auth.Attributes["cache_mode"]))
	if mode != "" && mode != "auto" {
		return auth
	}
	resolved := "off"
	if hasPreviousResponseID(req.Payload) || hasPreviousResponseID(opts.OriginalRequest) {
		resolved = "session"
	}
	next := *auth
	next.Attributes = cloneStringMap(auth.Attributes)
	next.Attributes["cache_mode"] = resolved
	return &next
}

func hasPreviousResponseID(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	var body struct {
		PreviousResponseID string `json:"previous_response_id"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return false
	}
	return strings.TrimSpace(body.PreviousResponseID) != ""
}

func cloneStringMap(values map[string]string) map[string]string {
	cloned := make(map[string]string, len(values)+1)
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}
