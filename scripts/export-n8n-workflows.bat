@echo off
REM Jarvis UI - Export n8n Workflows (CMD version)
REM Downloads all n8n workflows to JSON files
REM
REM Usage:
REM   export-n8n-workflows.bat                     - Export active workflows only
REM   export-n8n-workflows.bat --include-archived  - Include archived workflows
REM   export-n8n-workflows.bat --organize-by-folder - Organize by n8n projects/tags

set "SCRIPT_DIR=%~dp0"
set "EXTRA_ARGS="

:parse_args
if "%1"=="" goto done_args
if "%1"=="--include-archived" set "EXTRA_ARGS=%EXTRA_ARGS% --include-archived"
if "%1"=="-a" set "EXTRA_ARGS=%EXTRA_ARGS% --include-archived"
if "%1"=="--organize-by-folder" set "EXTRA_ARGS=%EXTRA_ARGS% --organize-by-folder"
if "%1"=="-f" set "EXTRA_ARGS=%EXTRA_ARGS% --organize-by-folder"
shift
goto parse_args
:done_args
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "N8N_PATH=%PROJECT_ROOT%\n8n"

echo ======================================
echo   n8n Workflow Exporter
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

REM Clean workflows folder before export
if exist "%N8N_PATH%\workflows" (
    echo Cleaning existing workflows folder...
    rmdir /s /q "%N8N_PATH%\workflows"
)

REM Run the export script
echo Exporting workflows...
echo.
python export_workflows.py %EXTRA_ARGS%

cd ..

echo.
echo Done!

