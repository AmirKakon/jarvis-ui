@echo off
REM Jarvis UI - Build Frontend for Production (CMD version)

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "FRONTEND_PATH=%PROJECT_ROOT%\frontend"

echo ======================================
echo   Jarvis UI - Production Build
echo ======================================
echo.

cd /d "%FRONTEND_PATH%"

echo Building frontend...
call npm run build

echo.
echo Build complete!
echo.
echo The frontend is now built in frontend\dist\
echo Start the backend server to serve the production build:
echo   scripts\start-backend.bat
echo.

pause

