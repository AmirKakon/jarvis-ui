# Jarvis UI - Start Backend Only
# Convenient script to just start the backend server

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPath = Join-Path $ProjectRoot "backend"

$venvPath = Join-Path $BackendPath "venv"
$activateScript = Join-Path $venvPath "Scripts\Activate.ps1"

if (-not (Test-Path $activateScript)) {
    Write-Host "ERROR: Virtual environment not found. Run setup.ps1 first." -ForegroundColor Red
    exit 1
}

Set-Location $BackendPath
& $activateScript

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Backend Server" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Starting on http://localhost:20003" -ForegroundColor Green
Write-Host "API Docs: http://localhost:20003/docs" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

python main.py

