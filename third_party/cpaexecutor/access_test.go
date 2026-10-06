package relaybridge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
)

type loopbackTestProvider struct{}

func (loopbackTestProvider) Identifier() string { return "test" }
func (loopbackTestProvider) Authenticate(_ context.Context, request *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	if request.Header.Get("Authorization") != "Bearer private-loopback-key" {
		return nil, sdkaccess.NewInvalidCredentialError()
	}
	return &sdkaccess.Result{Provider: "test", Principal: "private-loopback-key"}, nil
}

func TestRelayPrincipalRequiresPrivateLoopbackAuthentication(t *testing.T) {
	provider := relayPrincipalProvider{Provider: loopbackTestProvider{}}
	request := httptest.NewRequest(http.MethodGet, "/v1/realtime", nil)
	request.Header.Set("X-Relay-Principal", "key-a")
	if result, err := provider.Authenticate(t.Context(), request); err == nil || result != nil {
		t.Fatal("forged principal bypassed authentication")
	}
	request.Header.Set("Authorization", "Bearer private-loopback-key")
	result, err := provider.Authenticate(t.Context(), request)
	if err != nil || result.Principal != "key-a" {
		t.Fatalf("Relay key identity was lost: %+v %v", result, err)
	}
	request.Header.Set("X-Relay-Principal", "key-b")
	second, err := provider.Authenticate(t.Context(), request)
	if err != nil || second.Principal != "key-b" || result.Principal != "key-a" {
		t.Fatal("different Relay keys share CPA session ownership")
	}
}
