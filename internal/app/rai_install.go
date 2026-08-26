package app

import (
	_ "embed"
	"net/http"
	"strings"
	"text/template"
)

//go:embed setup_templates/rai-install.sh
var raiInstallShellSource string

//go:embed setup_templates/rai-install.ps1
var raiInstallPowerShellSource string

var raiInstallShellTemplate = template.Must(template.New("rai-install.sh").Parse(raiInstallShellSource))
var raiInstallPowerShellTemplate = template.Must(template.New("rai-install.ps1").Parse(raiInstallPowerShellSource))

func (a *App) raiInstallScript(w http.ResponseWriter, r *http.Request) {
	server := strings.TrimRight(strings.ReplaceAll(a.cfg.PublicURL, "'", ""), "/")
	if server == "" {
		writeError(w, http.StatusInternalServerError, "public_url_missing", "未配置站点地址")
		return
	}
	data := struct{ Server string }{Server: server}
	if strings.HasSuffix(r.URL.Path, ".ps1") {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `inline; filename="rai-install.ps1"`)
		if r.Method != http.MethodHead {
			_ = raiInstallPowerShellTemplate.Execute(w, data)
		}
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="rai-install.sh"`)
	if r.Method != http.MethodHead {
		_ = raiInstallShellTemplate.Execute(w, data)
	}
}
