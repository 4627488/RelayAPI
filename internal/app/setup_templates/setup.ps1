param([switch]$Check)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$EndpointBase64 = '{{.EndpointBase64}}'
$ApiKeyBase64 = '{{.APIKeyBase64}}'
$ClaudePatchBase64 = '{{.ClaudePatchBase64}}'
$OpenCodePatchBase64 = '{{.OpenCodePatchBase64}}'
$CodexEditsBase64 = '{{.CodexEditsBase64}}'
$DoCodex = {{if .Codex}}$true{{else}}$false{{end}}
$DoClaude = {{if .Claude}}$true{{else}}$false{{end}}
$DoOpenCode = {{if .OpenCode}}$true{{else}}$false{{end}}
$InstallMissing = {{if .InstallMissing}}$true{{else}}$false{{end}}
$VerifyConnection = {{if .VerifyConnection}}$true{{else}}$false{{end}}

function ConvertFrom-SetupBase64([string]$Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}
function Write-SetupInfo([string]$Message) { Write-Host "  $Message" }
function Write-SetupOk([string]$Message) { Write-Host "OK $Message" -ForegroundColor Green }
function Stop-Setup([string]$Message) { throw $Message }
function Get-SetupJsonProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

$Endpoint = ConvertFrom-SetupBase64 $EndpointBase64
$ApiKey = ConvertFrom-SetupBase64 $ApiKeyBase64

function Test-SetupGateway {
  Write-SetupInfo "Checking $Endpoint/v1/models"
  $headers = @{ Authorization = "Bearer $ApiKey" }
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$Endpoint/v1/models" -Headers $headers | Out-Null
  Write-SetupOk 'Gateway and API Key are reachable.'
}

if ($VerifyConnection) { Test-SetupGateway }

function Get-SetupCommand([string]$Name) {
  return Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($Check) {
  foreach ($name in @($(if ($DoCodex) {'codex'}), $(if ($DoClaude) {'claude'}), $(if ($DoOpenCode) {'opencode'}))) {
    if (-not $name) { continue }
    $command = Get-SetupCommand $name
    if ($command) {
      $version = & $command.Source --version 2>$null | Select-Object -First 1
      Write-SetupOk "$name $version"
    } else {
      Write-Warning "$name is not installed."
    }
  }
  Write-SetupOk 'Preflight completed; no files were changed.'
  return
}

function Install-SetupCli([string]$Name) {
  if (Get-SetupCommand $Name) { return }
  if (-not $InstallMissing) { Stop-Setup "$Name is missing and automatic installation is disabled." }
  switch ($Name) {
    'codex' {
      Write-SetupInfo 'Installing Codex with the official installer.'
      $previous = $env:CODEX_NON_INTERACTIVE
      try {
        $env:CODEX_NON_INTERACTIVE = 'true'
        & ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.ps1')))
      } finally { $env:CODEX_NON_INTERACTIVE = $previous }
    }
    'claude' {
      Write-SetupInfo 'Installing Claude Code with the official installer.'
      & ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1')))
    }
    'opencode' {
      Write-SetupInfo 'Installing OpenCode.'
      if (Get-SetupCommand npm) { & npm install -g opencode-ai }
      elseif (Get-SetupCommand choco) { & choco install opencode -y }
      elseif (Get-SetupCommand scoop) { & scoop install opencode }
      else { Stop-Setup 'OpenCode automatic installation on Windows requires npm, Chocolatey, or Scoop.' }
    }
  }
  if (-not (Get-SetupCommand $Name)) { Stop-Setup "$Name was installed but is not on PATH; open a new PowerShell window and run this setup again." }
}

if ($DoCodex) { Install-SetupCli codex }
if ($DoClaude) { Install-SetupCli claude }
if ($DoOpenCode) { Install-SetupCli opencode }

$script:Backups = New-Object System.Collections.ArrayList
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
function Backup-SetupTarget([string]$Path) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $existed = Test-Path -LiteralPath $Path
  $backup = $null
  if ($existed) {
    $backup = "$Path.relayapi-backup.$stamp.$PID"
    Copy-Item -LiteralPath $Path -Destination $backup
  }
  [void]$script:Backups.Add([pscustomobject]@{ Path = $Path; Existed = $existed; Backup = $backup })
}
function Restore-SetupTargets {
  for ($index = $script:Backups.Count - 1; $index -ge 0; $index--) {
    $item = $script:Backups[$index]
    if ($item.Existed) { Copy-Item -LiteralPath $item.Backup -Destination $item.Path -Force }
    elseif (Test-Path -LiteralPath $item.Path) { Remove-Item -LiteralPath $item.Path -Force }
  }
}
function Protect-SetupFile([string]$Path) {
  if ($env:OS -eq 'Windows_NT') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path '/inheritance:r' "/grant:r" "${identity}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Setup "could not protect $Path" }
  } elseif (Get-Command chmod -ErrorAction SilentlyContinue) {
    & chmod 600 $Path
  }
}
function Merge-SetupObject($Base, $Patch, [string]$Mode = 'default', [string]$Path = '') {
  foreach ($property in $Patch.PSObject.Properties) {
    $existing = $Base.PSObject.Properties[$property.Name]
    $patchIsObject = $property.Value -is [pscustomobject]
    $baseIsObject = $existing -and $existing.Value -is [pscustomobject]
    $childPath = if ($Path) { "$Path.$($property.Name)" } else { $property.Name }
    if ($Mode -eq 'opencode' -and $childPath -eq 'provider.relayapi.models') {
      $Base | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
    }
    elseif ($patchIsObject -and $baseIsObject) { Merge-SetupObject $existing.Value $property.Value $Mode $childPath }
    else { $Base | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force }
  }
}
function Merge-SetupJson([string]$Path, [string]$PatchBase64, [string]$Mode = 'default') {
  $base = if (Test-Path -LiteralPath $Path) { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } else { [pscustomobject]@{} }
  $patch = (ConvertFrom-SetupBase64 $PatchBase64) | ConvertFrom-Json
  Merge-SetupObject $base $patch $Mode
  if ($Mode -eq 'opencode') {
    $disabled = Get-SetupJsonProperty $base 'disabled_providers'
    if ($disabled -is [array]) {
      $base | Add-Member -NotePropertyName 'disabled_providers' -NotePropertyValue @($disabled | Where-Object { $_ -ne 'relayapi' }) -Force
    }
    $enabled = Get-SetupJsonProperty $base 'enabled_providers'
    if ($enabled -is [array] -and $enabled -notcontains 'relayapi') {
      $base | Add-Member -NotePropertyName 'enabled_providers' -NotePropertyValue (@($enabled) + @('relayapi')) -Force
    }
  }
  $stage = "$Path.relayapi-stage.$PID"
  try {
    $json = $base | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($stage, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json | Out-Null
    Protect-SetupFile $stage
    Move-Item -LiteralPath $stage -Destination $Path -Force
  } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force } }
}

$keyDir = Join-Path $HOME '.config\relayapi'
$keyPath = Join-Path $keyDir 'api-key'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$codexConfig = Join-Path $codexHome 'config.toml'
$claudeConfig = Join-Path $HOME '.claude\settings.json'
$openCodeConfig = Join-Path $HOME '.config\opencode\opencode.json'

Backup-SetupTarget $keyPath
if ($DoCodex) { Backup-SetupTarget $codexConfig }
if ($DoClaude) { Backup-SetupTarget $claudeConfig }
if ($DoOpenCode) { Backup-SetupTarget $openCodeConfig }

try {
  $keyStage = "$keyPath.relayapi-stage.$PID"
  [IO.File]::WriteAllText($keyStage, $ApiKey, (New-Object Text.UTF8Encoding($false)))
  Protect-SetupFile $keyStage
  Move-Item -LiteralPath $keyStage -Destination $keyPath -Force
  Protect-SetupFile $keyPath
  $ApiKey = $null
  $ApiKeyBase64 = $null

  if ($DoCodex) {
    $edits = (ConvertFrom-SetupBase64 $CodexEditsBase64) | ConvertFrom-Json
    $codexCommand = (Get-SetupCommand codex).Source
    $start = New-Object Diagnostics.ProcessStartInfo
    if ([IO.Path]::GetExtension($codexCommand) -in @('.cmd', '.bat')) {
      $start.FileName = $env:ComSpec
      $start.Arguments = '/d /s /c ""' + $codexCommand + '" app-server --listen stdio://"'
    } else {
      $start.FileName = $codexCommand
      $start.Arguments = 'app-server --listen stdio://'
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { Stop-Setup 'failed to start Codex app-server.' }
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $budgetMs = 60000
    $readResponse = {
      param([int]$WantId)
      while ($true) {
        $remaining = $budgetMs - $watch.ElapsedMilliseconds
        if ($remaining -le 0) { Stop-Setup 'Codex app-server timed out.' }
        $task = $process.StandardOutput.ReadLineAsync()
        if (-not $task.Wait([int]$remaining)) { Stop-Setup 'Codex app-server timed out.' }
        $line = $task.GetAwaiter().GetResult()
        if ($null -eq $line) { Stop-Setup 'Codex app-server exited before confirming the request.' }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $message = $line | ConvertFrom-Json } catch { Stop-Setup 'Codex app-server returned malformed JSON.' }
        $messageId = Get-SetupJsonProperty $message 'id'
        if ($null -eq $messageId -or $messageId -ne $WantId) { continue }
        if ($null -ne (Get-SetupJsonProperty $message 'error')) { Stop-Setup 'Codex app-server rejected the configuration request.' }
        $resultProperty = $message.PSObject.Properties['result']
        if ($null -eq $resultProperty) { Stop-Setup 'Codex app-server response did not include a result.' }
        return $resultProperty.Value
      }
    }
    try {
      $process.StandardInput.WriteLine((@{ jsonrpc='2.0'; id=1; method='initialize'; params=@{ clientInfo=@{ name='relayapi-setup'; title='RelayAPI Setup'; version='1' }; capabilities=$null } } | ConvertTo-Json -Depth 20 -Compress))
      [void](& $readResponse 1)
      $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"initialized"}')
      $process.StandardInput.WriteLine((@{ jsonrpc='2.0'; id=2; method='config/batchWrite'; params=@{ edits=$edits } } | ConvertTo-Json -Depth 30 -Compress))
      $result = & $readResponse 2
    } finally {
      try { $process.StandardInput.Close() } catch { }
      if (-not $process.WaitForExit(1000)) { $process.Kill(); $process.WaitForExit() }
      $stderr = $stderrTask.GetAwaiter().GetResult()
    }
    $status = Get-SetupJsonProperty $result 'status'
    if ($status -ne 'ok' -and $status -ne 'okOverridden') {
      if ($stderr) { Write-Warning $stderr }
      Stop-Setup "Codex did not confirm the configuration write (status: $status)."
    }
    Write-SetupOk "Codex configured in $codexConfig"
  }
  if ($DoClaude) { Merge-SetupJson $claudeConfig $ClaudePatchBase64; Write-SetupOk "Claude Code configured in $claudeConfig" }
  if ($DoOpenCode) { Merge-SetupJson $openCodeConfig $OpenCodePatchBase64 'opencode'; Write-SetupOk "OpenCode configured in $openCodeConfig" }
} catch {
  Write-Warning 'Setup failed; restoring every configuration changed in this run.'
  Restore-SetupTargets
  throw
}

if ($VerifyConnection) {
  $ApiKey = [IO.File]::ReadAllText($keyPath)
  Test-SetupGateway
  $ApiKey = $null
}
Write-SetupOk 'RelayAPI agent setup completed.'
Write-SetupInfo "Credential: $keyPath (restricted ACL)"
Write-SetupInfo 'Existing settings were merged. Timestamped backups were kept beside changed files.'
