@echo off
REM Jarvis UI - Import n8n Workflows (CMD version)
REM Imports/updates n8n workflows from JSON files
REM
REM Usage:
REM   import-n8n-workflows.bat                  - Import and activate all
REM   import-n8n-workflows.bat --no-activate    - Import without activating
REM   import-n8n-workflows.bat --dry-run        - Preview changes only

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "N8N_PATH=%PROJECT_ROOT%\n8n"
set "EXTRA_ARGS="

:parse_args
if "%1"=="" goto done_args
if "%1"=="--no-activate" set "EXTRA_ARGS=%EXTRA_ARGS% --no-activate"
if "%1"=="--dry-run" set "EXTRA_ARGS=%EXTRA_ARGS% --dry-run"
shift
goto parse_args
:done_args

echo ======================================
echo   n8n Workflow Importer
echo ======================================
echo.

REM Create venv if it doesn't exist
if not exist "%N8N_PATH%\venv\Scripts\activate.bat" (
    echo Creating virtual environment...
    cd /d "%N8N_PATH%"
    python -m venv venv
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        exit /b 1
    )
    echo Virtual environment created.
)

cd /d "%N8N_PATH%"
call venv\Scripts\activate.bat

REM Install/update requirements
echo Installing dependencies...
pip install -q -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies.
    exit /b 1
)
echo.

REM Check for .env file
if not exist "%N8N_PATH%\.env" (
    echo WARNING: .env file not found at %N8N_PATH%\.env
    echo Create it with:
    echo   N8N_BASE_URL=http://your-n8n-server:5678
    echo   N8N_API_KEY=n8n_api_xxxxxxxxxxxxxxxx
    echo.
)

REM Run the import script
echo Importing workflows...
echo.
python import_workflows.py %EXTRA_ARGS%

cd ..

echo.
echo Done!

