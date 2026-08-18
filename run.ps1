# StepAgent launcher for Windows. The macOS/Linux equivalent is run.sh.
#
#   .\run.ps1 --serve          start the server
#   .\run.ps1 --all --serve    import every session, then start the server
#   .\run.ps1 --all            import only
#
# Arguments other than --serve are forwarded to codex_prettify.py unchanged.
#
# If PowerShell refuses to run the file, launch it as:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 --serve

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host @'
uv was not found on PATH.

uv installs the right Python version and the project dependencies for you, so
it is the only prerequisite. Install it with one of:

  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
  winget install --id=astral-sh.uv -e

Then open a new terminal and run this script again.
Full instructions: https://docs.astral.sh/uv/
'@
    exit 1
}

# A first run without .env gets the documented defaults rather than an error.
if ((-not (Test-Path -LiteralPath '.env')) -and (Test-Path -LiteralPath '.env.example')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Created .env from .env.example.'
}

if (Test-Path -LiteralPath '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $name = $trimmed.Substring(0, $split).Trim()
        $value = $trimmed.Substring($split + 1).Trim().Trim('"').Trim("'")
        Set-Item -Path "Env:$name" -Value $value
    }
}

$serve = $false
$forwarded = @()
foreach ($arg in $args) {
    if ($arg -eq '--serve') { $serve = $true } else { $forwarded += $arg }
}

if ($forwarded.Count -gt 0 -or -not $serve) {
    & uv run --no-dev python codex_prettify.py @forwarded
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($serve) {
    $serverHost = if ($env:DJANGO_HOST) { $env:DJANGO_HOST } else { '127.0.0.1' }
    $port = if ($env:DJANGO_PORT) { $env:DJANGO_PORT } else { '8000' }
    Write-Host "StepAgent: http://${serverHost}:${port}/visualization/"
    & uv run --no-dev python manage.py runserver "${serverHost}:${port}"
    exit $LASTEXITCODE
}
