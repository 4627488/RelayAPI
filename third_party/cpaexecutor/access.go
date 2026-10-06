package relaybridge

import (
	"context"
	"net/http"
	"strings"

	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
)

// CPA's realtime sessions use the authenticated principal for ownership.
// Preserve Relay's per-key identity after authenticating the private loopback
// key, so different tenants cannot appear as the same internal CPA caller.
type relayPrincipalProvider struct{ sdkaccess.Provider }

func (p relayPrincipalProvider) Authenticate(ctx context.Context, request *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	result, err := p.Provider.Authenticate(ctx, request)
	if err != nil || result == nil {
		return result, err
	}
	principal := strings.TrimSpace(request.Header.Get("X-Relay-Principal"))
	if principal == "" {
		return result, nil
	}
	copy := *result
	copy.Principal = principal
	return &copy, nil
}
