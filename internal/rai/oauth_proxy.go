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
	server, listener, localToken, err := a.newProfileProxy(ctx, store, profile, false)
	if err != nil {
		return "", "", nil, err
	}
	go func() { _ = server.Serve(listener) }()
	return "http://" + listener.Addr().String(), localToken, func() { _ = server.Close() }, nil
}

func (a *App) newProfileProxy(ctx context.Context, store Store, profile Profile, managed bool) (*http.Server, net.Listener, string, error) {
	base, err := managementServer(profile.ServerURL)
	if err != nil {
		return nil, nil, "", err
	}
	target, _ := url.Parse(base)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, nil, "", err
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
		if managed && r.URL.Path == "/_rai/health" && r.Method == http.MethodGet {
			w.Header().Set("Cache-Control", "no-store")
			_, _ = io.WriteString(w, Version)
			return
		}
		if managed && r.URL.Path == "/_rai/stop" && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusNoContent)
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = server.Shutdown(ctx)
			}()
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			http.NotFound(w, r)
			return
		}
		current, err := store.ResolveProfile(profile.Name)
		if err != nil || current.ServerURL != profile.ServerURL {
			http.Error(w, "Run rai login to renew device authorization", http.StatusUnauthorized)
			return
		}
		access, err := a.profileCredential(r.Context(), store, current)
		if err != nil {
			http.Error(w, "Run rai login to renew device authorization", http.StatusUnauthorized)
			return
		}
		r.Header.Set("Authorization", "Bearer "+access)
		r.Header.Set("X-API-Key", access)
		proxy.ServeHTTP(w, r)
	})
	return server, listener, localToken, nil
}
