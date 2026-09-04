# Stops the SYNCAXIS Dashboard process started by start.ps1, using the PID
# recorded in .syncaxis-dashboard.pid.
#
# If this app is running as an NSSM Windows Service instead, use
# `nssm stop SyncaxisDashboard`  -  this script only knows about processes it
# started itself via start.ps1.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root '.syncaxis-dashboard.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found  -  Syncaxis Dashboard doesn't appear to be running (or wasn't started with start.ps1)." -ForegroundColor Yellow
    exit 0
}

$targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
$proc = if ($targetPid) { Get-Process -Id $targetPid -ErrorAction SilentlyContinue } else { $null }

if (-not $proc) {
    Write-Host "Process (PID $targetPid) isn't running  -  removing stale PID file." -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

Stop-Process -Id $targetPid -Force
Remove-Item $pidFile -Force
Write-Host "Syncaxis Dashboard stopped (PID $targetPid)." -ForegroundColor Green
