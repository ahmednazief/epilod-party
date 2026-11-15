@echo off
cd /d "%~dp0.."
call npx tauri dev
if errorlevel 1 (
    echo.
    echo Epilod Party dev exited with error code %errorlevel%.
    pause
)
