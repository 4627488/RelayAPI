package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/4627488/RelayAPI/internal/config"
)

func TestRAIDownloadServesBundledBinary(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "version"), []byte("build-abc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rai-linux-amd64"), []byte("linux-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{cfg: config.Config{RAIBinDir: dir}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/rai/download/linux-amd64", nil)
	request.SetPathValue("target", "linux-amd64")
	app.raiDownload(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != "linux-binary" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	if recorder.Header().Get("X-Rai-Version") != "build-abc" {
		t.Fatalf("version = %q", recorder.Header().Get("X-Rai-Version"))
	}
}

func TestRAIDownloadRejectsUnknownTarget(t *testing.T) {
	app := &App{cfg: config.Config{RAIBinDir: t.TempDir()}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/rai/download/../etc/passwd", nil)
	request.SetPathValue("target", "../etc/passwd")
	app.raiDownload(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestRAIDownloadUnavailableWithoutBinDir(t *testing.T) {
	app := &App{cfg: config.Config{}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/rai/download/linux-amd64", nil)
	request.SetPathValue("target", "linux-amd64")
	app.raiDownload(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
}
