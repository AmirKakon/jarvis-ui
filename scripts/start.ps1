# Jarvis UI - Start Script
# Starts both backend and frontend servers

param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$Production,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPath = Join-Path $ProjectRoot "backend"
$FrontendPath = Join-Path $ProjectRoot "frontend"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Starting Application" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Start Backend
if (-not $FrontendOnly) {
    Write-Host "Starting Backend Server..." -ForegroundColor Yellow
    
    $venvPath = Join-Path $BackendPath "venv"
    $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
    
    if (-not (Test-Path $activateScript)) {
        Write-Host "ERROR: Virtual environment not found. Run setup.ps1 first." -ForegroundColor Red
        exit 1
    }
    
    # Start backend in new PowerShell window
    $backendCmd = @"
Set-Location '$BackendPath'
& '$activateScript'
Write-Host 'Backend server starting on port 20005...' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop' -ForegroundColor Gray
Write-Host ''
python main.py
"@
    
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd
    Write-Host "  Backend started in new window" -ForegroundColor Green
    
    # Wait a moment for backend to start
    Start-Sleep -Seconds 5
}

# Start Frontend
if (-not $BackendOnly) {
    if ($Production) {
        Write-Host "Building Frontend for Production..." -ForegroundColor Yellow
        Push-Location $FrontendPath
        npm run build
        Pop-Location
        Write-Host "  Frontend built. Serve from backend at http://localhost:20005" -ForegroundColor Green
    } else {
        Write-Host "Starting Frontend Dev Server..." -ForegroundColor Yellow
        
        # Start frontend in new PowerShell window
        $frontendCmd = @"
Set-Location '$FrontendPath'
Write-Host 'Frontend dev server starting on port 20006...' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop' -ForegroundColor Gray
Write-Host ''
npm run dev
"@
        
        Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd
        Write-Host "  Frontend started in new window" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Application Started!" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

if ($Production) {
    Write-Host "Access the application at:" -ForegroundColor White
    Write-Host "  http://localhost:20005" -ForegroundColor Cyan
} else {
    Write-Host "Access the application at:" -ForegroundColor White
    Write-Host "  Frontend (dev): http://localhost:20006" -ForegroundColor Cyan
    Write-Host "  Backend API:    http://localhost:20005" -ForegroundColor Cyan
    Write-Host "  API Docs:       http://localhost:20005/docs" -ForegroundColor Cyan
}
Write-Host ""

# Open browser
if (-not $NoBrowser -and -not $Production) {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:20006"
}

