# Jarvis UI - Install as Windows Auto-Start Service
# This script creates scheduled tasks to auto-start Jarvis UI on Windows boot
# Run as Administrator!

param(
    [switch]$Docker,      # Use Docker Compose instead of native
    [switch]$Uninstall,   # Remove the scheduled tasks
    [string]$User         # Username for the task (default: current user)
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TaskNameBackend = "JarvisUI-Backend"
$TaskNameFrontend = "JarvisUI-Frontend"
$TaskNameDocker = "JarvisUI-Docker"

# Check for admin privileges
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "Please run PowerShell as Administrator and try again." -ForegroundColor Yellow
    exit 1
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Windows Service Installer" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

if ($Uninstall) {
    Write-Host "Uninstalling Jarvis UI services..." -ForegroundColor Yellow
    
    # Remove scheduled tasks
    $tasks = @($TaskNameBackend, $TaskNameFrontend, $TaskNameDocker)
    foreach ($task in $tasks) {
        if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $task -Confirm:$false
            Write-Host "  Removed task: $task" -ForegroundColor Green
        }
    }
    
    Write-Host ""
    Write-Host "Jarvis UI services uninstalled successfully!" -ForegroundColor Green
    exit 0
}

# Get the user for the task
if (-not $User) {
    $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

Write-Host "Project root: $ProjectRoot" -ForegroundColor Gray
Write-Host "Running as user: $User" -ForegroundColor Gray
Write-Host ""

if ($Docker) {
    Write-Host "Installing Docker Compose auto-start service..." -ForegroundColor Yellow
    
    # Check if Docker is installed
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: Docker is not installed or not in PATH." -ForegroundColor Red
        exit 1
    }
    
    # Create the startup script
    $dockerStartScript = Join-Path $ProjectRoot "scripts\start-docker-service.ps1"
    $scriptContent = @"
# Jarvis UI Docker Auto-Start Script
Set-Location '$ProjectRoot'
docker-compose up -d
"@
    Set-Content -Path $dockerStartScript -Value $scriptContent
    
    # Create scheduled task for Docker
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dockerStartScript`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
    
    # Remove existing task if present
    if (Get-ScheduledTask -TaskName $TaskNameDocker -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskNameDocker -Confirm:$false
    }
    
    Register-ScheduledTask -TaskName $TaskNameDocker -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Start Jarvis UI using Docker Compose"
    
    Write-Host "  Created scheduled task: $TaskNameDocker" -ForegroundColor Green
    
} else {
    Write-Host "Installing native Windows auto-start services..." -ForegroundColor Yellow
    
    # Check prerequisites
    $venvPath = Join-Path $ProjectRoot "backend\venv"
    if (-not (Test-Path (Join-Path $venvPath "Scripts\python.exe"))) {
        Write-Host "ERROR: Backend virtual environment not found." -ForegroundColor Red
        Write-Host "Please run .\scripts\setup.ps1 first." -ForegroundColor Yellow
        exit 1
    }
    
    $nodeModules = Join-Path $ProjectRoot "frontend\node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-Host "ERROR: Frontend node_modules not found." -ForegroundColor Red
        Write-Host "Please run .\scripts\setup.ps1 first." -ForegroundColor Yellow
        exit 1
    }
    
    # Create backend startup script (hidden window)
    $backendStartScript = Join-Path $ProjectRoot "scripts\start-backend-service.ps1"
    $backendScriptContent = @"

# Jarvis UI Backend Auto-Start Script
`$ErrorActionPreference = "Continue"
`$ProjectRoot = '$ProjectRoot'
`$BackendPath = Join-Path `$ProjectRoot "backend"
`$LogPath = Join-Path `$ProjectRoot "logs"

# Create logs directory
if (-not (Test-Path `$LogPath)) {
    New-Item -ItemType Directory -Path `$LogPath -Force | Out-Null
}

`$LogFile = Join-Path `$LogPath "backend.log"

# Start transcript for logging
Start-Transcript -Path `$LogFile -Append

try {
    Set-Location `$BackendPath
    & (Join-Path `$BackendPath "venv\Scripts\python.exe") -m uvicorn main:app --host 0.0.0.0 --port 20005
} catch {
    Write-Host "Error: `$_"
}

Stop-Transcript
"@
    Set-Content -Path $backendStartScript -Value $backendScriptContent
    
    # Create frontend startup script (hidden window)
    $frontendStartScript = Join-Path $ProjectRoot "scripts\start-frontend-service.ps1"
    $frontendScriptContent = @"
# Jarvis UI Frontend Auto-Start Script
`$ErrorActionPreference = "Continue"
`$ProjectRoot = '$ProjectRoot'
`$FrontendPath = Join-Path `$ProjectRoot "frontend"
`$LogPath = Join-Path `$ProjectRoot "logs"

# Create logs directory
if (-not (Test-Path `$LogPath)) {
    New-Item -ItemType Directory -Path `$LogPath -Force | Out-Null
}

`$LogFile = Join-Path `$LogPath "frontend.log"

# Start transcript for logging
Start-Transcript -Path `$LogFile -Append

try {
    Set-Location `$FrontendPath
    npm run dev
} catch {
    Write-Host "Error: `$_"
}

Stop-Transcript
"@
    Set-Content -Path $frontendStartScript -Value $frontendScriptContent
    
    # Wait time for backend to start before frontend
    $backendDelaySeconds = 10
    
    # Create scheduled task for Backend
    $actionBackend = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$backendStartScript`""
    $triggerBackend = New-ScheduledTaskTrigger -AtStartup
    $settingsBackend = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principalBackend = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
    
    if (Get-ScheduledTask -TaskName $TaskNameBackend -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskNameBackend -Confirm:$false
    }
    
    Register-ScheduledTask -TaskName $TaskNameBackend -Action $actionBackend -Trigger $triggerBackend -Settings $settingsBackend -Principal $principalBackend -Description "Jarvis UI Backend Server (Port 20005)"
    Write-Host "  Created scheduled task: $TaskNameBackend" -ForegroundColor Green
    
    # Create scheduled task for Frontend (with delay)
    $actionFrontend = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$frontendStartScript`""
    $triggerFrontend = New-ScheduledTaskTrigger -AtStartup
    $triggerFrontend.Delay = "PT${backendDelaySeconds}S"  # Delay to let backend start first
    $settingsFrontend = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principalFrontend = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
    
    if (Get-ScheduledTask -TaskName $TaskNameFrontend -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskNameFrontend -Confirm:$false
    }
    
    Register-ScheduledTask -TaskName $TaskNameFrontend -Action $actionFrontend -Trigger $triggerFrontend -Settings $settingsFrontend -Principal $principalFrontend -Description "Jarvis UI Frontend Server (Port 20006)"
    Write-Host "  Created scheduled task: $TaskNameFrontend" -ForegroundColor Green
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Services will auto-start on next Windows boot." -ForegroundColor White
Write-Host ""
Write-Host "To start services now, run:" -ForegroundColor Yellow
if ($Docker) {
    Write-Host "  docker-compose up -d" -ForegroundColor Cyan
} else {
    Write-Host "  .\scripts\start.ps1" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "To uninstall, run:" -ForegroundColor Yellow
Write-Host "  .\scripts\install-service.ps1 -Uninstall" -ForegroundColor Cyan
Write-Host ""
Write-Host "Ports:" -ForegroundColor White
Write-Host "  Backend:  http://localhost:20005" -ForegroundColor Gray
Write-Host "  Frontend: http://localhost:20006" -ForegroundColor Gray
Write-Host "  API Docs: http://localhost:20005/docs" -ForegroundColor Gray

