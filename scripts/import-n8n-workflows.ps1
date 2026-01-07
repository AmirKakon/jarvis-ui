# Jarvis UI - Import n8n Workflows
# Imports/updates n8n workflows from JSON files
#
# Usage:
#   .\import-n8n-workflows.ps1                  # Import and activate all
#   .\import-n8n-workflows.ps1 -NoActivate      # Import without activating
#   .\import-n8n-workflows.ps1 -DryRun          # Preview changes only

param(
    [switch]$NoActivate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$N8nPath = Join-Path $ProjectRoot "n8n"

$venvPath = Join-Path $N8nPath "venv"
$activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
$requirementsFile = Join-Path $N8nPath "requirements.txt"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  n8n Workflow Importer" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Create venv if it doesn't exist
if (-not (Test-Path $activateScript)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    Set-Location $N8nPath
    python -m venv venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to create virtual environment." -ForegroundColor Red
        exit 1
    }
    Write-Host "Virtual environment created." -ForegroundColor Green
}

# Activate venv
Set-Location $N8nPath
& $activateScript

# Install/update requirements
Write-Host "Installing dependencies..." -ForegroundColor Yellow
pip install -q -r $requirementsFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install dependencies." -ForegroundColor Red
    exit 1
}
Write-Host ""

# Check for .env file
$envFile = Join-Path $N8nPath ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "WARNING: .env file not found at $envFile" -ForegroundColor Yellow
    Write-Host "Create it with:" -ForegroundColor Yellow
    Write-Host "  N8N_BASE_URL=http://your-n8n-server:5678" -ForegroundColor Gray
    Write-Host "  N8N_API_KEY=n8n_api_xxxxxxxxxxxxxxxx" -ForegroundColor Gray
    Write-Host ""
}

# Run the import script
Write-Host "Importing workflows..." -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "(dry run - no changes will be made)" -ForegroundColor Gray
}
if ($NoActivate) {
    Write-Host "(workflows will NOT be activated)" -ForegroundColor Gray
} else {
    Write-Host "(workflows will be activated after import)" -ForegroundColor Gray
}
Write-Host ""

$args = @()
if ($NoActivate) { $args += "--no-activate" }
if ($DryRun) { $args += "--dry-run" }

python import_workflows.py @args

cd ..

Write-Host ""
Write-Host "Done!" -ForegroundColor Green

