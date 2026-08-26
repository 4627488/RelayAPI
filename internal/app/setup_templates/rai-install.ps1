# Install rai from this RelayAPI deployment and sign in.
$ErrorActionPreference = "Stop"
$Server = '{{.Server}}'
$Prefix = if ($env:RAI_PREFIX) { $env:RAI_PREFIX } else { Join-Path $env:LOCALAPPDATA "rai" }
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$dest = Join-Path $Prefix "rai.exe"
$arch = "amd64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
try {
    Invoke-WebRequest -Uri "$Server/rai/download/windows-$arch" -Headers @{ "User-Agent" = "rai-installer" } -OutFile $dest
} catch {
    throw "This deployment did not serve a rai binary for windows-$arch. The published RelayAPI image ships these binaries at /rai/download."
}
Write-Host "installed $dest"
$env:Path = "$Prefix;$env:Path"
if ($env:RAI_SKIP_LOGIN -eq "1") {
    Write-Host "next: rai login --server $Server"
    return
}
& $dest login --server $Server
