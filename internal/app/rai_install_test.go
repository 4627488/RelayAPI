package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/config"
)

func TestRAIInstallScriptBakesServerAndLogin(t *testing.T) {
	app := &App{cfg: config.Config{PublicURL: "https://relay.example"}}
	recorder := httptest.NewRecorder()
	app.raiInstallScript(recorder, httptest.NewRequest(http.MethodGet, "/rai/install.sh", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "SERVER='https://relay.example'") {
		t.Fatalf("missing server: %s", body)
	}
	if !strings.Contains(body, `login --server "$SERVER"`) {
		t.Fatalf("missing login: %s", body)
	}
	if !strings.Contains(body, `"$SERVER/rai/download/${OS}-${ARCH}"`) {
		t.Fatalf("missing site download: %s", body)
	}
	if strings.Contains(body, "api.github.com") {
		t.Fatal("hosted installer must not use GitHub releases")
	}
	if recorder.Header().Get("Content-Type") != "text/x-shellscript; charset=utf-8" {
		t.Fatalf("content-type = %q", recorder.Header().Get("Content-Type"))
	}
}

func TestRAIInstallPowerShellBakesServer(t *testing.T) {
	app := &App{cfg: config.Config{PublicURL: "https://relay.example"}}
	recorder := httptest.NewRecorder()
	app.raiInstallScript(recorder, httptest.NewRequest(http.MethodGet, "/rai/install.ps1", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "$Server = 'https://relay.example'") {
		t.Fatalf("missing server: %s", body)
	}
	if !strings.Contains(body, "login --server $Server") {
		t.Fatalf("missing login: %s", body)
	}
	if !strings.Contains(body, "$Server/rai/download/windows-$arch") {
		t.Fatalf("missing site download: %s", body)
	}
	if strings.Contains(body, "api.github.com") {
		t.Fatal("hosted installer must not use GitHub releases")
	}
}
