@echo off
REM Windows Command Prompt Bootstrap for Pi & LFM3 Installer

WHERE python >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python was not found in your PATH.
    echo Please install Python 3.9+ from https://python.org or via Microsoft Store.
    pause
    exit /b 1
)

python "%~dp0setup_wizard.py" %*
