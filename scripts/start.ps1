# Starts the SYNCAXIS Dashboard (node server.js) in the background and
# records its PID in .syncaxis-dashboard.pid so stop.ps1 can find it again.
#
# If this app is already installed as an NSSM Windows Service (see
# dashboard-app/DEPLOYMENT.md), use `nssm start SyncaxisDashboard` /
# `nssm stop SyncaxisDashboard` instead of these scripts  -  running both at
# once will fight over the same port.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'dashboard-app'
$pidFile = Join-Path $root '.syncaxis-dashboard.pid'
$logFile = Join-Path $root 'dashboard-app.log'
$errLogFile = Join-Path $root 'dashboard-app.err.log'

# Read PORT from .env for the friendly "open this URL" message (defaults to
# 3000 if .env or the PORT line isn't found  -  matches server.js's own default).
$port = 3000
$envFile = Join-Path $appDir '.env'
if (Test-Path $envFile) {
    $portLine = Select-String -Path $envFile -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue
    if ($portLine) { $port = $portLine.Matches[0].Groups[1].Value }
}

# Already running via this script?
if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Host "Syncaxis Dashboard is already running (PID $existingPid)." -ForegroundColor Yellow
        Write-Host "Open http://localhost:$port"
        exit 0
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Something else already bound to the port? (e.g. an NSSM service, or a
# manually-started `npm start`)  -  don't try to start a second instance.
try {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    if ($inUse) {
        Write-Host "Port $port is already in use (PID $($inUse[0].OwningProcess))  -  not starting a second instance." -ForegroundColor Yellow
        Write-Host "If that's an NSSM service, manage it with 'nssm restart SyncaxisDashboard' instead."
        exit 1
    }
} catch {
    # No listener found on that port  -  fine, proceed to start.
}

if (-not (Test-Path (Join-Path $appDir 'node_modules'))) {
    Write-Host "node_modules not found in '$appDir'  -  run 'npm install' (or 'npm ci') there first." -ForegroundColor Red
    exit 1
}

$startArgs = @{
    FilePath               = 'node'
    ArgumentList           = 'server.js'
    WorkingDirectory       = $appDir
    RedirectStandardOutput = $logFile
    RedirectStandardError  = $errLogFile
    WindowStyle            = 'Hidden'
    PassThru               = $true
}
$process = Start-Process @startArgs

Start-Sleep -Seconds 1
if ($process.HasExited) {
    Write-Host "Syncaxis Dashboard failed to start  -  check $errLogFile for the error:" -ForegroundColor Red
    Get-Content $errLogFile -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}

$process.Id | Out-File -FilePath $pidFile -Encoding ascii -NoNewline

Write-Host "Syncaxis Dashboard started (PID $($process.Id))." -ForegroundColor Green
Write-Host "Open http://localhost:$port"
Write-Host "Logs: $logFile"
