@echo off
REM Jarvis UI - Database Migration Script (CMD version)

echo ======================================
echo   Jarvis UI - Database Migration
echo ======================================
echo.

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "BACKEND_PATH=%PROJECT_ROOT%\backend"

REM Check for virtual environment
if not exist "%BACKEND_PATH%\venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found. Run setup.bat first.
    exit /b 1
)

REM Activate and run migration
cd /d "%BACKEND_PATH%"
call venv\Scripts\activate.bat

REM Check for .env file
if not exist ".env" (
    echo ERROR: .env file not found. Copy env.example to .env and configure it.
    exit /b 1
)

echo Upgrading database to head...
alembic upgrade head

echo.
echo Migration complete!
echo.
echo Current database revision:
alembic current

pause

