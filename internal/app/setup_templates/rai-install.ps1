# Install rai and sign in to this RelayAPI deployment.
$ErrorActionPreference = "Stop"
$Server = '{{.Server}}'
$Repo = if ($env:RAI_REPO) { $env:RAI_REPO } else { "4627488/RelayAPI" }
$Prefix = if ($env:RAI_PREFIX) { $env:RAI_PREFIX } else { Join-Path $env:LOCALAPPDATA "rai" }
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$dest = Join-Path $Prefix "rai.exe"
$installed = $false
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "rai-installer" }
    $asset = $release.assets | Where-Object { $_.name -match "rai-windows-amd64" } | Select-Object -First 1
    if ($asset) {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest
        $installed = $true
    }
} catch {
    $installed = $false
}
if (-not $installed) {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        Write-Error "No published rai binary, and go is not on PATH. Install Go, then: go install github.com/$Repo/cmd/rai@latest"
    }
    $env:GOBIN = $Prefix
    go install "github.com/$Repo/cmd/rai@latest"
}
Write-Host "installed $dest"
$env:Path = "$Prefix;$env:Path"
if ($env:RAI_SKIP_LOGIN -eq "1") {
    Write-Host "next: rai login --server $Server"
    return
}
& $dest login --server $Server
