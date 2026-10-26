package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("RAI_TEST_PROXY_PROCESS") == "1" {
		os.Exit(Main())
	}
	os.Exit(m.Run())
}

func TestPersistentProxyProcessReusesEndpointAndRenews(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	var rotations, requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/rai/token":
			rotations.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"access_token": "rai_at_rotated", "refresh_token": "rai_rt_rotated", "purpose": "inference", "expires_in": 900})
		case "/v1/models":
			if r.Header.Get("Authorization") != "Bearer rai_at_rotated" {
				t.Error("upstream did not receive rotated access token")
			}
			requests.Add(1)
			io.WriteString(w, `{"data":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Home: t.TempDir(), Self: binary, Environ: mergeEnv(os.Environ(), map[string]string{"RAI_TEST_PROXY_PROCESS": "1"}), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	a.defaults()
	store, profile := saveTestOAuth(t, a, upstream.URL, "inference", time.Now().Add(-time.Minute))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	base, token, err := a.ensurePersistentProxy(ctx, store, profile)
	if err != nil {
		t.Fatal(err)
	}
	state := proxyState{URL: base, Token: token}
	t.Cleanup(func() { _, _ = proxyRequest(context.Background(), state, http.MethodPost, "/_rai/stop") })
	// A second launcher/store instance reuses the independent process. There
	// is no child-client lifetime or in-memory credential dependency.
	b := &App{Home: store.Home, Self: binary, Environ: a.Environ}
	b.defaults()
	base2, token2, err := b.ensurePersistentProxy(ctx, store, profile)
	if err != nil || base != base2 || token != token2 {
		t.Fatal("proxy endpoint was not reused")
	}
	if ok, err := proxyRequest(ctx, state, http.MethodGet, "/v1/models"); !ok || err != nil {
		t.Fatalf("background request failed: %v", err)
	}
	if rotations.Load() != 1 || requests.Load() != 1 {
		t.Fatal("background process did not refresh credentials")
	}
	if err := store.DeleteCredential(profileCredentialName(profile)); err != nil {
		t.Fatal(err)
	}
	if ok, _ := proxyRequest(ctx, state, http.MethodGet, "/v1/models"); ok {
		t.Fatal("deleted credential remained usable")
	}
	if ok, err := proxyRequest(ctx, state, http.MethodPost, "/_rai/stop"); !ok || err != nil {
		t.Fatalf("stop failed: %v", err)
	}
}
