$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $PSScriptRoot '.env.local'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Invoke-Wslc {
    & wslc @args
    if ($LASTEXITCODE -ne 0) { throw "wslc $($args[0]) failed ($LASTEXITCODE)" }
}

function Test-Wslc {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & wslc @args *> $null
        return $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $previous }
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

if (!(Test-Path -LiteralPath $envFile)) {
    $password = New-Secret
    $content = @(
        'POSTGRES_USER=relay', 'POSTGRES_DB=relay_dev', "POSTGRES_PASSWORD=$password",
        "DATABASE_URL=postgres://relay:${password}@relayapi-dev-postgres:5432/relay_dev?sslmode=disable",
        "TEST_DATABASE_URL=postgres://relay:${password}@relayapi-dev-postgres:5432/relay_test?sslmode=disable",
        "RELAY_SESSION_SECRET=$(New-Secret)", "RELAY_API_KEY_ENCRYPTION_KEY=$(New-Secret)",
        'LISTEN_ADDR=:3000', 'RELAY_PUBLIC_URL=http://localhost:5173', 'RELAY_SECURE_COOKIES=false'
    ) -join "`n"
    [System.IO.File]::WriteAllText($envFile, "$content`n", $utf8)
}

if (!(Test-Wslc network inspect relayapi-dev)) { Invoke-Wslc network create relayapi-dev }
Invoke-Wslc volume create relayapi-dev-postgres
Invoke-Wslc volume create relayapi-dev-workspace

if (!(Test-Wslc container inspect relayapi-dev-postgres)) {
    Invoke-Wslc run -d --name relayapi-dev-postgres --network relayapi-dev `
        --env-file $envFile -v relayapi-dev-postgres:/var/lib/postgresql/data `
        --health-cmd 'pg_isready -U relay -d relay_dev' --health-interval 5s `
        --health-timeout 3s --health-retries 20 postgres:17-alpine
} else {
    Invoke-Wslc start relayapi-dev-postgres
}

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Wslc exec relayapi-dev-postgres pg_isready -U relay -d relay_dev) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (!$ready) { throw 'Development PostgreSQL did not become ready.' }
$testDatabase = & wslc exec relayapi-dev-postgres psql -U relay -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='relay_test'"
if ($LASTEXITCODE -ne 0) { throw 'Could not check the test database.' }
if (($testDatabase -join '').Trim() -ne '1') {
    Invoke-Wslc exec relayapi-dev-postgres createdb -U relay relay_test
}

# Seed once into Linux storage. Later starts preserve edits in this workspace.
$seeded = & wslc run --rm -v relayapi-dev-workspace:/workspace postgres:17-alpine sh -c 'test -d /workspace/.git'
if ($LASTEXITCODE -ne 0) {
    $archive = Join-Path ([System.IO.Path]::GetTempPath()) "relayapi-dev-$([guid]::NewGuid()).tar"
    $fileList = "$archive.files"
    try {
        $files = @(& git -C $workspace ls-files) + @('.git')
        if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate workspace files.' }
        $files += Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Name -notlike '*.local' } | ForEach-Object { ".devcontainer/$($_.Name)" }
        $files += 'docs/development-container.md'
        [System.IO.File]::WriteAllLines($fileList, ($files | Sort-Object -Unique), $utf8)
        & tar.exe -C $workspace -cf $archive --exclude=.git/index.lock -T $fileList
        if ($LASTEXITCODE -ne 0) { throw 'Could not archive the workspace.' }
        Invoke-Wslc run --rm -v relayapi-dev-workspace:/workspace -v "${archive}:/tmp/workspace.tar:ro" `
            postgres:17-alpine sh -c 'tar -xf /tmp/workspace.tar -C /workspace && chown -R 1000:1000 /workspace'
    } finally {
        Remove-Item -LiteralPath $archive, $fileList -Force -ErrorAction SilentlyContinue
    }
}
Write-Host 'RelayAPI Linux workspace and development/test databases are ready.'
