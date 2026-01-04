@echo off
REM Jarvis UI - Setup Script for Windows (CMD version)
REM This script sets up both backend and frontend environments

echo ======================================
echo   Jarvis UI - Setup Script
echo ======================================
echo.

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."

REM Check for Python
echo [1/4] Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Python not found. Please install Python 3.10+ from https://python.org
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version') do echo   Found: %%i

REM Check for Node.js
echo [2/4] Checking Node.js installation...
node --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js not found. Please install Node.js 18+ from https://nodejs.org
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo   Found: Node.js %%i

REM Setup Backend
echo.
echo [3/4] Setting up Backend...
cd /d "%PROJECT_ROOT%\backend"

if not exist "venv" (
    echo   Creating virtual environment...
    python -m venv venv
) else (
    echo   Virtual environment already exists.
)

echo   Installing Python dependencies...
call venv\Scripts\activate.bat
pip install --upgrade pip >nul
pip install -r requirements.txt

REM Create .env if it doesn't exist
if not exist ".env" (
    if exist "env.example" (
        copy env.example .env >nul
        echo   Created .env file from template. Please update with your settings!
    )
) else (
    echo   .env file already exists.
)

echo   Backend setup complete!

REM Setup Frontend
echo.
echo [4/4] Setting up Frontend...
cd /d "%PROJECT_ROOT%\frontend"

if not exist "node_modules" (
    echo   Installing npm dependencies...
    call npm install
) else (
    echo   node_modules already exists.
)

echo   Frontend setup complete!

echo.
echo ======================================
echo   Setup Complete!
echo ======================================
echo.
echo Next steps:
echo   1. Edit backend\.env with your PostgreSQL and n8n settings
echo   2. Run database migrations: scripts\migrate.bat
echo   3. Start the app: scripts\start.bat
echo.

pause

