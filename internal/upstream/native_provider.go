package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptrace"
	"strings"
	"time"
)

func (r *nativeRuntime) doProviderRequest(source *http.Request, credential *nativeCredential, target, requestPath string, body []byte, trace *RequestTrace) (*http.Response, error) {
	if credential.tokenNeedsRefresh() {
		_ = r.refreshCredential(source.Context(), credential)
	}
	request, err := http.NewRequestWithContext(source.Context(), source.Method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	copyProviderHeaders(request.Header, source.Header)
	credential.authorize(request.Header, requestPath)
	clientTraceState, clientTrace := providerClientTrace()
	request = request.WithContext(httptrace.WithClientTrace(request.Context(), clientTrace))
	attemptStarted := time.Now()
	response, err := credential.client.Do(request)
	snapshot := clientTraceState.snapshot()
	recorded := ExecutionAttempt{
		Number: 1, StartedAt: attemptStarted, CompletedAt: time.Now(),
		RequestWrittenAt: snapshot.wroteRequest, FirstResponseAt: snapshot.firstResponseByte,
		GetConnAt: snapshot.getConn, GotConnAt: snapshot.gotConn,
		DNSStartedAt: snapshot.dnsStart, DNSCompletedAt: snapshot.dnsDone,
		ConnectStartedAt: snapshot.connectStart, ConnectCompletedAt: snapshot.connectDone,
		TLSStartedAt: snapshot.tlsStart, TLSCompletedAt: snapshot.tlsDone,
		Provider: credential.Provider, Model: jsonString(body, "model"), CredentialID: credential.ID,
		ConnectionReused: snapshot.reused, RemoteAddr: snapshot.remoteAddr,
	}
	if err != nil {
		recorded.Status, recorded.Error = "failed", err.Error()
	} else if response.StatusCode >= 400 {
		recorded.Status, recorded.Error = "failed", fmt.Sprintf("HTTP %d", response.StatusCode)
		recorded.HeadersAt = snapshot.firstResponseByte
	} else {
		recorded.Status = "complete"
		recorded.HeadersAt = snapshot.firstResponseByte
	}
	trace.addAttempt(recorded)
	if err == nil && response.StatusCode == http.StatusUnauthorized && credential.hasRefreshToken() {
		_ = r.refreshCredential(source.Context(), credential)
	}
	return response, err
}

func (r *nativeRuntime) RefreshCredential(ctx context.Context, id string, force bool) ([]byte, bool, error) {
	r.mu.RLock()
	credential := r.credentials[strings.TrimSpace(id)]
	r.mu.RUnlock()
	if credential == nil {
		return nil, false, fmt.Errorf("upstream credential %q is not registered", id)
	}
	if !credential.hasRefreshToken() {
		return credential.currentDocument(), false, nil
	}
	if !force && !credential.tokenNeedsRefresh() {
		return credential.currentDocument(), false, nil
	}
	if err := r.refreshCredential(ctx, credential); err != nil {
		return nil, false, err
	}
	return credential.currentDocument(), true, nil
}

func (r *nativeRuntime) RefreshDueCredentials(ctx context.Context) (refreshed, failed int) {
	if r == nil {
		return 0, 0
	}
	r.mu.RLock()
	ids := make([]string, 0, len(r.credentials))
	for id, credential := range r.credentials {
		if credential.hasRefreshToken() && credential.tokenNeedsRefresh() {
			ids = append(ids, id)
		}
	}
	r.mu.RUnlock()
	for _, id := range ids {
		if ctx.Err() != nil {
			return refreshed, failed
		}
		_, did, err := r.RefreshCredential(ctx, id, false)
		if err != nil {
			failed++
			continue
		}
		if did {
			refreshed++
		}
	}
	return refreshed, failed
}

func (r *nativeRuntime) refreshCredential(ctx context.Context, credential *nativeCredential) error {
	credential.tokenMu.Lock()
	defer credential.tokenMu.Unlock()
	if credential.RefreshToken == "" {
		return errors.New("credential has no refresh token")
	}
	if credential.Provider != "codex" && credential.Provider != "kimi" && credential.Provider != "xai" {
		return errors.New("credential provider does not support token refresh")
	}
	endpoint := oauthTokenEndpoint(credential.Provider, credential.document)
	if endpoint == "" {
		return errors.New("credential token endpoint is missing")
	}
	form := oauthRefreshForm(credential.Provider, credential.RefreshToken)
	var tokens map[string]any
	var err error
	if credential.Provider == "kimi" {
		tokens, err = postOAuthFormHeaders(ctx, credential.client, endpoint, form, kimiOAuthHeaders(firstString(credential.document, "device_id")))
	} else {
		tokens, err = postOAuthForm(ctx, credential.client, endpoint, form)
	}
	if err != nil {
		return err
	}
	applyRefreshedTokens(credential, tokens, endpoint, time.Now())
	payload, err := json.Marshal(credential.document)
	if err != nil {
		return err
	}
	credential.Credential.Document = append(credential.Credential.Document[:0], payload...)
	if r.options.OnCredentialUpdated != nil {
		r.options.OnCredentialUpdated(context.WithoutCancel(ctx), credential.ID, append([]byte(nil), payload...))
	}
	return nil
}

func copyProviderHeaders(destination, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "sec-websocket-") {
			continue
		}
		switch lower {
		case "authorization", "x-api-key", "x-goog-api-key", "host", "content-length", "connection", "upgrade",
			"origin", "accept-encoding", "x-relay-upstream-credential-id":
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}
