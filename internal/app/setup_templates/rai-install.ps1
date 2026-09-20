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
$Prefix = (Resolve-Path -LiteralPath $Prefix).Path
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $Prefix) {
    try {
        [Environment]::SetEnvironmentVariable('Path', "$Prefix;$userPath", 'User')
        Write-Host "Added $Prefix to user PATH. Open a new terminal after installation."
    } catch {
        Write-Warning "Could not update user PATH. Add $Prefix to your user PATH manually."
    }
}
if (($env:Path -split ';') -notcontains $Prefix) { $env:Path = "$Prefix;$env:Path" }
if ($env:RAI_SKIP_LOGIN -eq "1") {
    Write-Host "next: rai login --server $Server"
    return
}
& $dest login --server $Server
if ($LASTEXITCODE -ne 0) { throw "rai login failed. Retry: rai login --server $Server" }
