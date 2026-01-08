@echo off
REM Jarvis UI - Start Frontend Dev Server (CMD version)

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "FRONTEND_PATH=%PROJECT_ROOT%\frontend"

cd /d "%FRONTEND_PATH%"

echo ======================================
echo   Jarvis UI - Frontend Dev Server
echo ======================================
echo.
echo Starting on http://localhost:20006
echo Press Ctrl+C to stop
echo.

npm run dev

