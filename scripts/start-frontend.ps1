# Jarvis UI - Start Frontend Only
# Convenient script to just start the frontend dev server

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FrontendPath = Join-Path $ProjectRoot "frontend"

Set-Location $FrontendPath

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Frontend Dev Server" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Starting on http://localhost:3000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

npm run dev

