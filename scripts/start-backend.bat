@echo off
REM Jarvis UI - Start Backend Server (CMD version)

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "BACKEND_PATH=%PROJECT_ROOT%\backend"

if not exist "%BACKEND_PATH%\venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found. Run setup.bat first.
    exit /b 1
)

cd /d "%BACKEND_PATH%"
call venv\Scripts\activate.bat

echo ======================================
echo   Jarvis UI - Backend Server
echo ======================================
echo.
echo Starting on http://localhost:20003
echo API Docs: http://localhost:20003/docs
echo Press Ctrl+C to stop
echo.

python main.py

