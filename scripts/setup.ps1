# Jarvis UI - Setup Script for Windows
# This script sets up both backend and frontend environments

param(
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Setup Script" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check for Python
Write-Host "[1/4] Checking Python installation..." -ForegroundColor Yellow
try {
    $pythonVersion = python --version 2>&1
    Write-Host "  Found: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Python not found. Please install Python 3.10+ from https://python.org" -ForegroundColor Red
    exit 1
}

# Check for Node.js
Write-Host "[2/4] Checking Node.js installation..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version 2>&1
    Write-Host "  Found: Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js not found. Please install Node.js 18+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Setup Backend
if (-not $SkipBackend) {
    Write-Host ""
    Write-Host "[3/4] Setting up Backend..." -ForegroundColor Yellow
    
    $backendPath = Join-Path $ProjectRoot "backend"
    $venvPath = Join-Path $backendPath "venv"
    
    # Create virtual environment
    if ((Test-Path $venvPath) -and -not $Force) {
        Write-Host "  Virtual environment already exists. Use -Force to recreate." -ForegroundColor Gray
    } else {
        if (Test-Path $venvPath) {
            Write-Host "  Removing existing virtual environment..." -ForegroundColor Gray
            Remove-Item -Recurse -Force $venvPath
        }
        Write-Host "  Creating virtual environment..." -ForegroundColor Gray
        Push-Location $backendPath
        python -m venv venv
        Pop-Location
    }
    
    # Activate and install requirements
    Write-Host "  Installing Python dependencies..." -ForegroundColor Gray
    $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
    & $activateScript
    
    Push-Location $backendPath
    pip install --upgrade pip | Out-Null
    pip install -r requirements.txt
    Pop-Location
    
    # Create .env if it doesn't exist
    $envFile = Join-Path $backendPath ".env"
    $envExample = Join-Path $backendPath ".env.example"
    if (-not (Test-Path $envFile)) {
        if (Test-Path $envExample) {
            Copy-Item $envExample $envFile
            Write-Host "  Created .env file from template. Please update with your settings!" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  .env file already exists." -ForegroundColor Gray
    }
    
    Write-Host "  Backend setup complete!" -ForegroundColor Green
} else {
    Write-Host "[3/4] Skipping Backend setup..." -ForegroundColor Gray
}

# Setup Frontend
if (-not $SkipFrontend) {
    Write-Host ""
    Write-Host "[4/4] Setting up Frontend..." -ForegroundColor Yellow
    
    $frontendPath = Join-Path $ProjectRoot "frontend"
    
    Push-Location $frontendPath
    
    # Install npm dependencies
    if ((Test-Path "node_modules") -and -not $Force) {
        Write-Host "  node_modules already exists. Use -Force to reinstall." -ForegroundColor Gray
    } else {
        Write-Host "  Installing npm dependencies..." -ForegroundColor Gray
        npm install
    }
    
    Pop-Location
    
    Write-Host "  Frontend setup complete!" -ForegroundColor Green
} else {
    Write-Host "[4/4] Skipping Frontend setup..." -ForegroundColor Gray
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Edit backend/.env with your PostgreSQL and n8n settings" -ForegroundColor Gray
Write-Host "  2. Run database migrations: .\scripts\migrate.ps1" -ForegroundColor Gray
Write-Host "  3. Start the app: .\scripts\start.ps1" -ForegroundColor Gray
Write-Host ""

