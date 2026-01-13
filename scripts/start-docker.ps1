# Jarvis UI - Start with Docker Compose
# Quick script to start all services using Docker

param(
    [switch]$Build,     # Force rebuild images
    [switch]$Detach,    # Run in background (detached)
    [switch]$Logs       # Follow logs after starting
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Docker Compose Start" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env exists
$envFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "WARNING: No .env file found in project root." -ForegroundColor Yellow
    Write-Host "Copy .env.docker.example to .env and configure it:" -ForegroundColor Yellow
    Write-Host "  copy .env.docker.example .env" -ForegroundColor Cyan
    Write-Host ""
    
    $response = Read-Host "Do you want to continue without .env? (y/N)"
    if ($response -notmatch "^[yY]") {
        exit 1
    }
}

Push-Location $ProjectRoot

try {
    # Build arguments
    $args = @("up")
    
    if ($Build) {
        $args += "--build"
        Write-Host "Building images..." -ForegroundColor Yellow
    }
    
    if ($Detach -or -not $Logs) {
        $args += "-d"
    }
    
    # Start containers
    Write-Host "Starting containers..." -ForegroundColor Yellow
    docker-compose @args
    
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed with exit code $LASTEXITCODE"
    }
    
    Write-Host ""
    Write-Host "Jarvis UI started successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Access the application:" -ForegroundColor White
    Write-Host "  Frontend: http://localhost:20006" -ForegroundColor Cyan
    Write-Host "  Backend:  http://localhost:20005" -ForegroundColor Cyan
    Write-Host "  API Docs: http://localhost:20005/docs" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Logs) {
        Write-Host "Following logs (Ctrl+C to stop)..." -ForegroundColor Yellow
        docker-compose logs -f
    } else {
        Write-Host "View logs with: docker-compose logs -f" -ForegroundColor Gray
        Write-Host "Stop with:      docker-compose down" -ForegroundColor Gray
    }
    
} finally {
    Pop-Location
}

