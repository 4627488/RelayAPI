package rai

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestUpdateDownloadsFromLoggedInSite(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	t.Setenv(envServer, "")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"name":"RelayAPI","kind":"rai.dev/v1","download":"/rai/download","rai_version":"site-9","contract_version":"1"}`)
	})
	mux.HandleFunc("GET /rai/download/"+runtime.GOOS+"-"+runtime.GOARCH, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Rai-Version", "site-9")
		io.WriteString(w, "new-rai-binary")
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "default", ServerURL: server.URL, DefaultModel: "m"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "rai")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	app := App{
		Args:    []string{"update"},
		Home:    home,
		Stdout:  stdout,
		Gateway: Gateway{HTTP: server.Client()},
		Self:    target,
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new-rai-binary" {
		t.Fatalf("binary = %q", data)
	}
	if !strings.Contains(stdout.String(), "site-9") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestUpdateSkipsWhenSiteVersionMatches(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	t.Setenv(envServer, "")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"download":"/rai/download","rai_version":"`+Version+`"}`)
	})
	mux.HandleFunc("GET /rai/download/", func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not download when versions match")
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "default", ServerURL: server.URL}); err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	app := App{
		Args:    []string{"update"},
		Home:    home,
		Stdout:  stdout,
		Gateway: Gateway{HTTP: server.Client()},
		Self:    filepath.Join(t.TempDir(), "rai"),
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "matches this site") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}
