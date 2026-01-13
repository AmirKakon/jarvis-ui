# Jarvis UI - Check Service Status
# Shows status of both native processes and Docker containers

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Jarvis UI - Service Status" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check Docker containers
Write-Host "Docker Containers:" -ForegroundColor Yellow
Push-Location $ProjectRoot
$dockerStatus = docker-compose ps 2>&1
if ($LASTEXITCODE -eq 0 -and $dockerStatus -notmatch "no configuration file") {
    Write-Host $dockerStatus
} else {
    Write-Host "  Docker not running or not available" -ForegroundColor Gray
}
Pop-Location
Write-Host ""

# Check native processes
Write-Host "Native Processes:" -ForegroundColor Yellow

# Backend (port 20005)
$backendConn = Get-NetTCPConnection -LocalPort 20005 -ErrorAction SilentlyContinue
if ($backendConn) {
    $backendPid = $backendConn | Select-Object -First 1 -ExpandProperty OwningProcess
    $backendProc = Get-Process -Id $backendPid -ErrorAction SilentlyContinue
    Write-Host "  Backend (20005):  " -NoNewline -ForegroundColor White
    Write-Host "RUNNING" -ForegroundColor Green -NoNewline
    Write-Host " (PID: $backendPid, $($backendProc.ProcessName))" -ForegroundColor Gray
} else {
    Write-Host "  Backend (20005):  " -NoNewline -ForegroundColor White
    Write-Host "NOT RUNNING" -ForegroundColor Red
}

# Frontend (port 20006)
$frontendConn = Get-NetTCPConnection -LocalPort 20006 -ErrorAction SilentlyContinue
if ($frontendConn) {
    $frontendPid = $frontendConn | Select-Object -First 1 -ExpandProperty OwningProcess
    $frontendProc = Get-Process -Id $frontendPid -ErrorAction SilentlyContinue
    Write-Host "  Frontend (20006): " -NoNewline -ForegroundColor White
    Write-Host "RUNNING" -ForegroundColor Green -NoNewline
    Write-Host " (PID: $frontendPid, $($frontendProc.ProcessName))" -ForegroundColor Gray
} else {
    Write-Host "  Frontend (20006): " -NoNewline -ForegroundColor White
    Write-Host "NOT RUNNING" -ForegroundColor Red
}

Write-Host ""

# Check scheduled tasks
Write-Host "Scheduled Tasks (Auto-Start):" -ForegroundColor Yellow
$tasks = @("JarvisUI-Backend", "JarvisUI-Frontend", "JarvisUI-Docker")
foreach ($taskName in $tasks) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $state = $task.State
        $color = if ($state -eq "Ready") { "Green" } elseif ($state -eq "Running") { "Cyan" } else { "Yellow" }
        Write-Host "  $taskName : " -NoNewline -ForegroundColor White
        Write-Host $state -ForegroundColor $color
    }
}

$foundTask = $tasks | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
if (-not $foundTask) {
    Write-Host "  No auto-start tasks installed" -ForegroundColor Gray
    Write-Host "  Run '.\scripts\install-service.ps1' to enable auto-start" -ForegroundColor Gray
}

Write-Host ""

# Health check
Write-Host "Health Check:" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:20005/api/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  API Health:       " -NoNewline -ForegroundColor White
    Write-Host "OK" -ForegroundColor Green
} catch {
    Write-Host "  API Health:       " -NoNewline -ForegroundColor White
    Write-Host "UNREACHABLE" -ForegroundColor Red
}

try {
    $response = Invoke-WebRequest -Uri "http://localhost:20006" -TimeoutSec 5 -ErrorAction Stop -UseBasicParsing
    Write-Host "  Frontend:         " -NoNewline -ForegroundColor White
    Write-Host "OK" -ForegroundColor Green
} catch {
    Write-Host "  Frontend:         " -NoNewline -ForegroundColor White
    Write-Host "UNREACHABLE" -ForegroundColor Red
}

Write-Host ""
Write-Host "Access URLs:" -ForegroundColor Yellow
Write-Host "  Frontend: http://localhost:20006" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:20005" -ForegroundColor Cyan
Write-Host "  API Docs: http://localhost:20005/docs" -ForegroundColor Cyan

