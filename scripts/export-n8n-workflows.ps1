# Jarvis UI - Export n8n Workflows
# Downloads all n8n workflows to JSON files
#
# Usage:
#   .\export-n8n-workflows.ps1                     # Export active workflows only
#   .\export-n8n-workflows.ps1 -IncludeArchived    # Include archived workflows
#   .\export-n8n-workflows.ps1 -OrganizeByFolder   # Organize by n8n projects/tags

param(
    [switch]$IncludeArchived,
    [switch]$OrganizeByFolder
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$N8nPath = Join-Path $ProjectRoot "n8n"

$venvPath = Join-Path $N8nPath "venv"
$activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
$requirementsFile = Join-Path $N8nPath "requirements.txt"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  n8n Workflow Exporter" -ForegroundColor Cyan
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

# Clean workflows folder before export
$workflowsPath = Join-Path $N8nPath "workflows"
if (Test-Path $workflowsPath) {
    Write-Host "Cleaning existing workflows folder..." -ForegroundColor Yellow
    Remove-Item -Path $workflowsPath -Recurse -Force
}

# Run the export script
Write-Host "Exporting workflows..." -ForegroundColor Cyan
if ($IncludeArchived) {
    Write-Host "(including archived workflows)" -ForegroundColor Gray
}
if ($OrganizeByFolder) {
    Write-Host "(organizing by folder)" -ForegroundColor Gray
}
Write-Host ""

$args = @()
if ($IncludeArchived) { $args += "--include-archived" }
if ($OrganizeByFolder) { $args += "--organize-by-folder" }

python export_workflows.py @args

cd ..

Write-Host ""
Write-Host "Done!" -ForegroundColor Green

