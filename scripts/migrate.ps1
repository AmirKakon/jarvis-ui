# Jarvis UI - Database Migration Script
# Runs Alembic migrations to create/update database schema

param(
    [switch]$Upgrade,
    [switch]$Downgrade,
    [string]$Revision = "head"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPath = Join-Path $ProjectRoot "backend"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Database Migration" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check for virtual environment
$venvPath = Join-Path $BackendPath "venv"
$activateScript = Join-Path $venvPath "Scripts\Activate.ps1"

if (-not (Test-Path $activateScript)) {
    Write-Host "ERROR: Virtual environment not found. Run setup.ps1 first." -ForegroundColor Red
    exit 1
}

# Activate virtual environment
& $activateScript

# Check for .env file
$envFile = Join-Path $BackendPath ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env file not found. Copy .env.example to .env and configure it." -ForegroundColor Red
    exit 1
}

# Change to backend directory
Push-Location $BackendPath

try {
    if ($Downgrade) {
        Write-Host "Downgrading database to revision: $Revision" -ForegroundColor Yellow
        alembic downgrade $Revision
    } else {
        Write-Host "Upgrading database to revision: $Revision" -ForegroundColor Yellow
        alembic upgrade $Revision
    }
    
    Write-Host ""
    Write-Host "Migration complete!" -ForegroundColor Green
    
    # Show current revision
    Write-Host ""
    Write-Host "Current database revision:" -ForegroundColor Yellow
    alembic current
} catch {
    Write-Host ""
    Write-Host "ERROR: Migration failed!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "  - Check DATABASE_URL in .env is correct" -ForegroundColor Gray
    Write-Host "  - Ensure PostgreSQL is running and accessible" -ForegroundColor Gray
    Write-Host "  - Verify network connectivity to database server" -ForegroundColor Gray
    exit 1
} finally {
    Pop-Location
}

