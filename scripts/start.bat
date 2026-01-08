@echo off
REM Jarvis UI - Start Both Servers (CMD version)

set "SCRIPT_DIR=%~dp0"

echo ======================================
echo   Jarvis UI - Starting Application
echo ======================================
echo.

echo Starting Backend Server in new window...
start "Jarvis Backend" cmd /k "%SCRIPT_DIR%start-backend.bat"

timeout /t 2 /nobreak >nul

echo Starting Frontend Dev Server in new window...
start "Jarvis Frontend" cmd /k "%SCRIPT_DIR%start-frontend.bat"

echo.
echo ======================================
echo   Application Started!
echo ======================================
echo.
echo Access the application at:
echo   Frontend (dev): http://localhost:20006
echo   Backend API:    http://localhost:20005
echo   API Docs:       http://localhost:20005/docs
echo.

timeout /t 3 /nobreak >nul
start http://localhost:20006

