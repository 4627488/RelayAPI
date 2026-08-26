package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/4627488/RelayAPI/internal/config"
)

func TestRAIDiscoveryDocument(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "version"), []byte("sha-test"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{cfg: config.Config{PublicURL: "https://relay.example", RAIBinDir: dir}}
	recorder := httptest.NewRecorder()
	app.raiDiscovery(recorder, httptest.NewRequest(http.MethodGet, "/.well-known/rai.json", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if document["kind"] != "rai.dev/v1" || document["api_base"] != "https://relay.example" {
		t.Fatalf("document = %#v", document)
	}
	if document["session"] != "/api/rai/session" {
		t.Fatalf("session = %#v", document["session"])
	}
	if document["authorization"] != "/api/rai/authorizations" || document["token"] != "/api/rai/token" {
		t.Fatalf("auth endpoints = %#v", document)
	}
	if document["install"] != "/rai/install.sh" {
		t.Fatalf("install = %#v", document["install"])
	}
	if document["download"] != "/rai/download" {
		t.Fatalf("download = %#v", document["download"])
	}
	if document["rai_version"] != "sha-test" {
		t.Fatalf("rai_version = %#v", document["rai_version"])
	}
}
