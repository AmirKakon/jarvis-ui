# Jarvis UI - Production Start (Native Windows)
# Starts backend and serves built frontend from the same port

param(
    [switch]$NoBuild,     # Skip frontend build
    [switch]$Background   # Run in background
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPath = Join-Path $ProjectRoot "backend"
$FrontendPath = Join-Path $ProjectRoot "frontend"
$LogPath = Join-Path $ProjectRoot "logs"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Production Mode" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check backend venv
$venvPython = Join-Path $BackendPath "venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "ERROR: Backend virtual environment not found." -ForegroundColor Red
    Write-Host "Run .\scripts\setup.ps1 first." -ForegroundColor Yellow
    exit 1
}

# Check backend .env
$envFile = Join-Path $BackendPath ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: Backend .env file not found." -ForegroundColor Red
    Write-Host "Copy backend\env.example to backend\.env and configure it." -ForegroundColor Yellow
    exit 1
}

# Build frontend if needed
$frontendDist = Join-Path $FrontendPath "dist"
if (-not $NoBuild) {
    if (-not (Test-Path $frontendDist) -or (Read-Host "Rebuild frontend? (y/N)") -match "^[yY]") {
        Write-Host "Building frontend..." -ForegroundColor Yellow
        Push-Location $FrontendPath
        npm run build
        Pop-Location
        
        if (-not (Test-Path $frontendDist)) {
            Write-Host "ERROR: Frontend build failed." -ForegroundColor Red
            exit 1
        }
        Write-Host "  Frontend built successfully!" -ForegroundColor Green
    }
} else {
    if (-not (Test-Path $frontendDist)) {
        Write-Host "WARNING: Frontend not built. Run without -NoBuild or build manually." -ForegroundColor Yellow
    }
}

Write-Host ""

# Create logs directory
if (-not (Test-Path $LogPath)) {
    New-Item -ItemType Directory -Path $LogPath -Force | Out-Null
}

if ($Background) {
    Write-Host "Starting backend in background..." -ForegroundColor Yellow
    
    # Start backend as background job
    $backendScript = @"
Set-Location '$BackendPath'
& '$venvPython' -m uvicorn main:app --host 0.0.0.0 --port 20005
"@
    
    Start-Process powershell -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-Command", $backendScript
    
    Write-Host "  Backend started in background" -ForegroundColor Green
    Write-Host ""
    Write-Host "Access the application at: http://localhost:20005" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "To stop, run: .\scripts\stop-service.ps1 -Native" -ForegroundColor Gray
    
} else {
    Write-Host "Starting backend server..." -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Access the application at: http://localhost:20005" -ForegroundColor Cyan
    Write-Host "API Docs: http://localhost:20005/docs" -ForegroundColor Cyan
    Write-Host ""
    
    Push-Location $BackendPath
    & $venvPython -m uvicorn main:app --host 0.0.0.0 --port 20005
    Pop-Location
}

