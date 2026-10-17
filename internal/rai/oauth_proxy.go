package rai

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// Clients that only accept environment credentials use a per-launch loopback
// proxy. Only the proxy reads refresh tokens; upstream calls always use a fresh
// access token. The random local credential expires when the child exits.
func (a *App) startOAuthProxy(ctx context.Context, store Store, profile Profile) (string, string, func(), error) {
	base, err := managementServer(profile.ServerURL)
	if err != nil {
		return "", "", nil, err
	}
	target, _ := url.Parse(base)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", "", nil, err
	}
	localToken := "rai_local_" + rand.Text()
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
		},
		ErrorLog: log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "RelayAPI upstream unavailable", http.StatusBadGateway)
		},
	}
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if presented == "" {
			presented = r.Header.Get("X-API-Key")
		}
		if subtle.ConstantTimeCompare([]byte(presented), []byte(localToken)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			http.NotFound(w, r)
			return
		}
		access, err := a.profileCredential(r.Context(), store, profile)
		if err != nil {
			http.Error(w, "Run rai login to renew device authorization", http.StatusUnauthorized)
			return
		}
		r.Header.Set("Authorization", "Bearer "+access)
		r.Header.Set("X-API-Key", access)
		proxy.ServeHTTP(w, r)
	})
	go func() { _ = server.Serve(listener) }()
	return "http://" + listener.Addr().String(), localToken, func() { _ = server.Close() }, nil
}
