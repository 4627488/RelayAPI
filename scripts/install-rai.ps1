# Install rai from a running RelayAPI site (RAI_SERVER), or go install for
# developers building from this repository.
$ErrorActionPreference = "Stop"
$Server = if ($env:RAI_SERVER) { $env:RAI_SERVER.TrimEnd("/") } else { "" }
$Repo = if ($env:RAI_REPO) { $env:RAI_REPO } else { "4627488/RelayAPI" }
$Prefix = if ($env:RAI_PREFIX) { $env:RAI_PREFIX } else { Join-Path $env:LOCALAPPDATA "rai" }
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$dest = Join-Path $Prefix "rai.exe"
if ($Server) {
    $arch = "amd64"
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
    Invoke-WebRequest -Uri "$Server/rai/download/windows-$arch" -Headers @{ "User-Agent" = "rai-installer" } -OutFile $dest
    Write-Host "installed $dest from $Server"
    return
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Error "Set RAI_SERVER to a running RelayAPI URL, or install Go and retry."
}
$env:GOBIN = $Prefix
go install "github.com/$Repo/cmd/rai@latest"
Write-Host "installed $dest via go install"
Write-Host "next: rai login --server <your RelayAPI URL>"
