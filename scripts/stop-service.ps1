# Jarvis UI - Stop Services Script
# Stops both native and Docker services

param(
    [switch]$Docker,  # Stop Docker containers
    [switch]$Native   # Stop native processes
)

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Stopping Services" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# If neither specified, try to stop both
if (-not $Docker -and -not $Native) {
    $Docker = $true
    $Native = $true
}

if ($Docker) {
    Write-Host "Stopping Docker containers..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    docker-compose down 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Docker containers stopped" -ForegroundColor Green
    } else {
        Write-Host "  No Docker containers running or Docker not available" -ForegroundColor Gray
    }
    Pop-Location
}

if ($Native) {
    Write-Host "Stopping native processes..." -ForegroundColor Yellow
    
    # Find and stop Python processes running uvicorn on port 20005
    $backendProcesses = Get-NetTCPConnection -LocalPort 20005 -ErrorAction SilentlyContinue | 
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    
    if ($backendProcesses) {
        $backendProcesses | Stop-Process -Force
        Write-Host "  Backend process stopped (port 20005)" -ForegroundColor Green
    } else {
        Write-Host "  No backend process found on port 20005" -ForegroundColor Gray
    }
    
    # Find and stop Node.js processes running on port 20006
    $frontendProcesses = Get-NetTCPConnection -LocalPort 20006 -ErrorAction SilentlyContinue | 
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    
    if ($frontendProcesses) {
        $frontendProcesses | Stop-Process -Force
        Write-Host "  Frontend process stopped (port 20006)" -ForegroundColor Green
    } else {
        Write-Host "  No frontend process found on port 20006" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "Services stopped!" -ForegroundColor Green

