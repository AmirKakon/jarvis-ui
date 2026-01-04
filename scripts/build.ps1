# Jarvis UI - Build Script
# Builds the frontend for production

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FrontendPath = Join-Path $ProjectRoot "frontend"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Production Build" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

Push-Location $FrontendPath

Write-Host "Building frontend..." -ForegroundColor Yellow
npm run build

Pop-Location

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "The frontend is now built in frontend/dist/" -ForegroundColor Gray
Write-Host "Start the backend server to serve the production build:" -ForegroundColor Gray
Write-Host "  .\scripts\start-backend.ps1" -ForegroundColor Cyan
Write-Host ""

