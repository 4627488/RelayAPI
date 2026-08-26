package app

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var raiDownloadFiles = map[string]string{
	"darwin-amd64":  "rai-darwin-amd64",
	"darwin-arm64":  "rai-darwin-arm64",
	"linux-amd64":   "rai-linux-amd64",
	"linux-arm64":   "rai-linux-arm64",
	"windows-amd64": "rai-windows-amd64.exe",
	"windows-arm64": "rai-windows-arm64.exe",
}

func (a *App) raiDownload(w http.ResponseWriter, r *http.Request) {
	target := strings.ToLower(strings.TrimSpace(r.PathValue("target")))
	name, ok := raiDownloadFiles[target]
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_target", "不支持的 rai 平台")
		return
	}
	dir := strings.TrimSpace(a.cfg.RAIBinDir)
	if dir == "" {
		writeError(w, http.StatusServiceUnavailable, "rai_unavailable", "此站点尚未附带 rai 二进制")
		return
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "rai_unavailable", "此站点尚未附带 rai 二进制")
		return
	}
	path := filepath.Join(root, name)
	if !strings.HasPrefix(path, root+string(os.PathSeparator)) && path != root {
		writeError(w, http.StatusNotFound, "unknown_target", "不支持的 rai 平台")
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, http.StatusServiceUnavailable, "rai_unavailable", "此站点尚未附带该平台的 rai 二进制")
		return
	}
	filename := "rai"
	if strings.HasSuffix(name, ".exe") {
		filename = "rai.exe"
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Rai-Version", a.raiBundledVersion())
	w.Header().Set("Cache-Control", "public, max-age=60")
	http.ServeFile(w, r, path)
}

func (a *App) raiBundledVersion() string {
	dir := strings.TrimSpace(a.cfg.RAIBinDir)
	if dir == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(dir, "version"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
